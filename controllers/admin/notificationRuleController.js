const Notification = require('../../models/Notification');
const NotificationRule = require('../../models/NotificationRule');
const User = require('../../models/User');
const { RULES, SEGMENTS, getRuleDef, validateEdit, validateVariants, VARIANTS_MAX, TITLE_MAX, MESSAGE_MAX } = require('../../utils/notificationRules');
const { audited } = require('../../utils/adminAudit');

const DAY = 24 * 60 * 60 * 1000;
const bad = (res, message) => res.status(400).json({ success: false, message });

/** Notification filter for one rule. `title` may be a string or a RegExp. */
const sentFilter = (def, since) => ({ ...def.match, createdAt: { $gte: since } });

async function sentStats(def, now) {
  const [row] = await Notification.aggregate([
    { $match: sentFilter(def, new Date(now - 30 * DAY)) },
    {
      $group: {
        _id: null,
        last30d: { $sum: 1 },
        last7d: { $sum: { $cond: [{ $gte: ['$createdAt', new Date(now - 7 * DAY)] }, 1, 0] } },
        lastSentAt: { $max: '$createdAt' },
      },
    },
  ]);
  return { last7d: row?.last7d || 0, last30d: row?.last30d || 0, lastSentAt: row?.lastSentAt || null };
}

function present(def, override, stats) {
  const rotating = Boolean(def.defaults.variants);
  const variants = rotating
    ? override?.variants?.length
      ? override.variants.map((v) => ({ title: v.title, message: v.message }))
      : def.defaults.variants
    : undefined;
  const title = rotating ? variants[0].title : override?.title || def.defaults.title;
  const message = rotating ? variants[0].message : override?.message || def.defaults.message;
  return {
    key: def.key,
    name: def.name,
    kind: def.kind,
    audience: def.audience,
    segments: def.segments,
    editable: def.editable,
    trigger: def.trigger,
    schedule: def.schedule,
    rotating,
    variants,
    placeholders: def.placeholders,
    sample: def.sample,
    enabled: override ? override.enabled !== false : true,
    title,
    message,
    // Only goal_nudge ships a separate push text; everything else pushes the message.
    pushBody: def.defaults.pushBody ? override?.pushBody || (override?.message ? override.message : def.defaults.pushBody) : undefined,
    defaults: def.defaults,
    customised: Boolean(override && (override.title || override.message || override.pushBody || override.variants?.length)),
    updatedAt: override?.updatedAt || null,
    updatedByEmail: override?.updatedByEmail || null,
    stats,
  };
}

/** Patients in each subscription group, using the same rule as the Users tab. */
async function segmentCounts(now = new Date()) {
  const patient = { role: 'patient' };
  const [signed_up, subscribed, lapsed] = await Promise.all([
    User.countDocuments({ ...patient, $or: [{ 'status.subscriptionExpiresAt': null }, { 'status.subscriptionExpiresAt': { $exists: false } }] }),
    User.countDocuments({ ...patient, 'status.subscriptionExpiresAt': { $gte: now } }),
    User.countDocuments({ ...patient, 'status.subscriptionExpiresAt': { $lt: now } }),
  ]);
  return { signed_up, subscribed, lapsed };
}

// GET /api/admin/notification-rules
exports.list = async (req, res, next) => {
  try {
    const now = Date.now();
    const [overrides, stats, counts] = await Promise.all([
      NotificationRule.find({}).lean(),
      Promise.all(RULES.map((d) => sentStats(d, now))),
      segmentCounts(new Date(now)),
    ]);
    const byKey = new Map(overrides.map((o) => [o.key, o]));
    res.json({
      success: true,
      data: {
        limits: { title: TITLE_MAX, message: MESSAGE_MAX, variants: VARIANTS_MAX },
        segments: Object.entries(SEGMENTS).map(([key, v]) => ({ key, ...v, patients: counts[key] })),
        items: RULES.map((d, i) => present(d, byKey.get(d.key), stats[i])),
      },
    });
  } catch (err) {
    next(err);
  }
};

// PUT /api/admin/notification-rules/:key  { enabled?, title?, message?, pushBody?, reset? }
exports.update = async (req, res, next) => {
  try {
    const def = getRuleDef(req.params.key);
    if (!def) return res.status(404).json({ success: false, message: 'Notification not found' });
    if (!def.editable) return bad(res, 'This notification is sent by the app and cannot be changed here');

    const body = req.body || {};
    const existing = await NotificationRule.findOne({ key: def.key }).lean();
    const before = { enabled: existing ? existing.enabled !== false : true, title: existing?.title, message: existing?.message, pushBody: existing?.pushBody, variants: existing?.variants };

    let set;
    if (body.reset === true) {
      // Back to shipped wording. The on/off switch is a separate decision and is kept.
      set = { title: null, message: null, pushBody: null, variants: null };
    } else if (def.defaults.variants) {
      // A rotating rule is edited as a whole list of wordings.
      set = {};
      if (body.variants !== undefined) {
        const variants = Array.isArray(body.variants)
          ? body.variants.map((v) => ({ title: String(v?.title ?? '').trim(), message: String(v?.message ?? '').trim() }))
          : body.variants;
        const err = validateVariants(def, variants);
        if (err) return bad(res, err);
        set.variants = variants;
      }
      if (body.enabled !== undefined) set.enabled = body.enabled === true;
    } else {
      const text = {};
      for (const f of ['title', 'message', 'pushBody']) if (body[f] !== undefined) text[f] = String(body[f]).trim();
      if (text.pushBody !== undefined && !def.defaults.pushBody) delete text.pushBody;
      const err = validateEdit(def, text);
      if (err) return bad(res, err);
      set = { ...text };
      if (body.enabled !== undefined) set.enabled = body.enabled === true;
    }
    if (!Object.keys(set).length) return bad(res, 'Nothing to change');

    const after = { ...before, ...set };
    await audited(
      req,
      { action: 'notification_rule.update', targetType: 'notification_rule', targetId: def.key, before, after },
      () =>
        NotificationRule.updateOne(
          { key: def.key },
          // $unset (not $set null) so "no override" really means absent.
          {
            $set: { ...Object.fromEntries(Object.entries(set).filter(([, v]) => v !== null)), updatedByEmail: req.admin?.email },
            ...(body.reset === true ? { $unset: { title: '', message: '', pushBody: '', variants: '' } } : {}),
          },
          { upsert: true }
        )
    );

    const [row, stats] = await Promise.all([NotificationRule.findOne({ key: def.key }).lean(), sentStats(def, Date.now())]);
    res.json({ success: true, data: present(def, row, stats) });
  } catch (err) {
    next(err);
  }
};
