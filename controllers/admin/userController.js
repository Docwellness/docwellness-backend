const mongoose = require('mongoose');
const { User, DietPlanRequest, ManualPaymentProof, DietPlan } = require('../../models');
const { STAGES, computeStage, buildJourney } = require('../../utils/patientJourney');
const { audited, writeAudit } = require('../../utils/adminAudit');
const { maskPhone, maskEmail, maskDob } = require('../../utils/piiMask');

const bad = (res, message, extra = {}) => res.status(400).json({ success: false, message, ...extra });
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const DAY = 24 * 3600 * 1000;
const nameOf = (u) => u?.profile?.fullName || '';

// Only these fields ever leave the database for the admin panel. Clinical
// content (meal logs, lab reports, chats, notes) is deliberately not reachable.
const LIST_FIELDS =
  'profile.fullName profile.whatsappNumber profile.profileImage email isActive lastLogin createdAt status.subscriptionExpiresAt';

function subscriptionState(expiresAt, now = Date.now()) {
  if (!expiresAt) return 'never';
  const t = new Date(expiresAt).getTime();
  if (t < now) return 'expired';
  if (t < now + 7 * DAY) return 'expiring';
  return 'active';
}

/** Latest diet plan request per patient (all patients when `ids` is null). */
async function latestRequests(ids) {
  const match = ids ? { patient: { $in: ids } } : {};
  const rows = await DietPlanRequest.aggregate([
    { $match: match },
    { $sort: { createdAt: -1 } },
    { $group: { _id: '$patient', doc: { $first: '$$ROOT' } } },
  ]);
  return new Map(rows.map((r) => [String(r._id), r.doc]));
}

/** Patients whose diet plan is being built or is finalized but not yet running. */
async function draftPlanPatients(ids) {
  const filter = { status: { $in: ['Draft', 'Finalized'] } };
  if (ids) filter.patientId = { $in: ids };
  const found = await DietPlan.distinct('patientId', filter);
  return new Set(found.map(String));
}

function journeyOf(userId, requests, drafts) {
  const request = requests.get(String(userId)) || null;
  const result = computeStage({ request, hasDraftPlan: drafts.has(String(userId)) });
  return {
    ...result,
    plan: request
      ? { name: request.membershipPlan || '', amount: request.membershipAmount ?? null, requestStatus: request.status }
      : null,
  };
}

function presentRow(u, journey) {
  return {
    ...(journey || {}),
    _id: u._id,
    name: nameOf(u),
    phone: maskPhone(u.profile?.whatsappNumber),
    email: maskEmail(u.email),
    isActive: u.isActive !== false,
    subscription: subscriptionState(u.status?.subscriptionExpiresAt),
    subscriptionExpiresAt: u.status?.subscriptionExpiresAt || null,
    lastLogin: u.lastLogin || null,
    createdAt: u.createdAt,
  };
}

// GET /api/admin/users?q=&subscription=&account=&page=&limit=
exports.listUsers = async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 25));
    const now = new Date();
    const and = [{ role: 'patient' }];

    const q = String(req.query.q || '').trim().slice(0, 80);
    if (q) {
      const rx = new RegExp(escapeRegex(q), 'i');
      const digits = q.replace(/\D/g, '');
      const or = [{ 'profile.fullName': rx }, { email: rx }];
      if (digits.length >= 3) or.push({ 'profile.whatsappNumber': new RegExp(escapeRegex(digits)) });
      and.push({ $or: or });
    }

    switch (req.query.subscription) {
      case 'active':
        and.push({ 'status.subscriptionExpiresAt': { $gte: new Date(now.getTime() + 7 * DAY) } });
        break;
      case 'expiring':
        and.push({ 'status.subscriptionExpiresAt': { $gte: now, $lt: new Date(now.getTime() + 7 * DAY) } });
        break;
      case 'expired':
        and.push({ 'status.subscriptionExpiresAt': { $lt: now } });
        break;
      case 'never':
        and.push({ $or: [{ 'status.subscriptionExpiresAt': null }, { 'status.subscriptionExpiresAt': { $exists: false } }] });
        break;
      default:
        break;
    }
    // Journey stage (request sent, diet in progress, payment, active ...)
    if (STAGES.includes(req.query.stage)) {
      const [requests, drafts] = await Promise.all([latestRequests(null), draftPlanPatients(null)]);
      if (req.query.stage === 'none') {
        and.push({ _id: { $nin: [...requests.keys()].map((k) => new mongoose.Types.ObjectId(k)) } });
      } else {
        const ids = [];
        for (const [pid, request] of requests) {
          if (computeStage({ request, hasDraftPlan: drafts.has(pid) }).stage === req.query.stage) {
            ids.push(new mongoose.Types.ObjectId(pid));
          }
        }
        and.push({ _id: { $in: ids } });
      }
    }
    if (req.query.account === 'suspended') and.push({ isActive: false });
    if (req.query.account === 'active') and.push({ isActive: { $ne: false } });

    const filter = { $and: and };
    const [rows, total] = await Promise.all([
      User.find(filter)
        .select(LIST_FIELDS)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      User.countDocuments(filter),
    ]);
    const pageIds = rows.map((r) => r._id);
    const [requests, drafts] = await Promise.all([latestRequests(pageIds), draftPlanPatients(pageIds)]);
    res.json({
      success: true,
      data: { items: rows.map((r) => presentRow(r, journeyOf(r._id, requests, drafts))), total, page, limit },
    });
  } catch (err) {
    next(err);
  }
};

async function loadPatient(id) {
  if (!mongoose.Types.ObjectId.isValid(String(id))) return null;
  const u = await User.findOne({ _id: id, role: 'patient' })
    .select(`${LIST_FIELDS} profile.gender healthProfile.primaryGoal healthProfile.weight healthProfile.height`)
    .lean();
  return u;
}

// GET /api/admin/users/:id
exports.getUser = async (req, res, next) => {
  try {
    const u = await loadPatient(req.params.id);
    if (!u) return res.status(404).json({ success: false, message: 'Patient not found' });

    const [request, proofs, plans] = await Promise.all([
      DietPlanRequest.findOne({ patient: u._id }).sort({ createdAt: -1 }).lean(),
      ManualPaymentProof.find({ patient: u._id }).sort({ createdAt: -1 }).select('status amountReceived createdAt reviewedAt').lean(),
      DietPlan.find({ patientId: u._id }).select('status createdAt updatedAt activationDate').lean(),
    ]);
    const hasDraftPlan = plans.some((p) => ['Draft', 'Finalized'].includes(p.status));
    const stageInfo = computeStage({ request, hasDraftPlan });
    const dietician = request?.dieticianId ? await User.findById(request.dieticianId).select('profile.fullName').lean() : null;

    res.json({
      success: true,
      data: {
        ...presentRow(u, { ...stageInfo, plan: null }),
        journey: buildJourney({ request, plans, proofs }),
        gender: u.profile?.gender || '',
        goal: u.healthProfile?.primaryGoal || request?.primaryGoal || '',
        weight: u.healthProfile?.weight ?? null,
        height: u.healthProfile?.height ?? null,
        dieticianName: nameOf(dietician),
        plan: request
          ? {
              name: request.membershipPlan || '',
              amount: request.membershipAmount ?? null,
              status: request.status,
              hasActivePlan: Boolean(request.hasActivePlan),
              requestedAt: request.createdAt,
              paymentRequestedAt: request.paymentRequestedAt || null,
              startedAt: request.subscriptionStartDate || null,
              expiresAt: request.subscriptionExpiresAt || u.status?.subscriptionExpiresAt || null,
            }
          : null,
        recentPayments: proofs.slice(0, 5).map((p) => ({ _id: p._id, status: p.status, amount: p.amountReceived, createdAt: p.createdAt })),
      },
    });
  } catch (err) {
    next(err);
  }
};

// POST /api/admin/users/:id/reveal   { field: 'phone' | 'email' | 'dob' }
exports.revealField = async (req, res, next) => {
  try {
    const field = req.body?.field;
    if (!['phone', 'email', 'dob'].includes(field)) return bad(res, 'Choose phone, email or dob');
    const u = await User.findOne({ _id: req.params.id, role: 'patient' }).select('email profile.whatsappNumber profile.dateOfBirth').lean();
    if (!u) return res.status(404).json({ success: false, message: 'Patient not found' });

    // The access is recorded first: no entry, no value.
    await writeAudit(req, {
      action: 'user.reveal',
      targetType: 'user',
      targetId: String(u._id),
      meta: { field },
    });
    const value =
      field === 'phone'
        ? u.profile?.whatsappNumber || ''
        : field === 'email'
          ? u.email || ''
          : u.profile?.dateOfBirth
            ? new Date(u.profile.dateOfBirth).toISOString().slice(0, 10)
            : '';
    res.json({ success: true, data: { field, value } });
  } catch (err) {
    next(err);
  }
};

async function setActive(req, res, next, active) {
  try {
    const reason = String(req.body?.reason || '').trim();
    if (!reason) return bad(res, 'A reason is required');
    const u = await User.findOne({ _id: req.params.id, role: 'patient' }).select('isActive profile.fullName');
    if (!u) return res.status(404).json({ success: false, message: 'Patient not found' });
    const current = u.isActive !== false;
    if (current === active) {
      return res.status(409).json({ success: false, message: active ? 'This account is already active' : 'This account is already suspended' });
    }
    await audited(
      req,
      {
        action: active ? 'user.reactivate' : 'user.suspend',
        targetType: 'user',
        targetId: String(u._id),
        before: { isActive: current },
        after: { isActive: active },
        reason,
        meta: { name: nameOf(u) },
      },
      async () => {
        u.isActive = active;
        await u.save();
      }
    );
    res.json({ success: true, data: { _id: u._id, isActive: active } });
  } catch (err) {
    next(err);
  }
}
exports.suspendUser = (req, res, next) => setActive(req, res, next, false);
exports.reactivateUser = (req, res, next) => setActive(req, res, next, true);

/**
 * New subscription end for an extension. Counted from the current end date,
 * or from today when the subscription has already ended.
 */
function extendedEnd(currentEnd, { days, until }, now = new Date()) {
  if (until) return new Date(until);
  const base = currentEnd && new Date(currentEnd).getTime() > now.getTime() ? new Date(currentEnd) : now;
  return new Date(base.getTime() + days * DAY);
}

// POST /api/admin/users/:id/extend-subscription   { days | until, reason }
exports.extendSubscription = async (req, res, next) => {
  try {
    const reason = String(req.body?.reason || '').trim();
    if (!reason) return bad(res, 'A reason is required');
    const days = req.body?.days === undefined ? undefined : Number(req.body.days);
    const until = req.body?.until ? new Date(req.body.until) : undefined;
    if (until === undefined && !(Number.isInteger(days) && days >= 1 && days <= 365)) {
      return bad(res, 'Give a number of days between 1 and 365, or an end date');
    }
    if (until && (Number.isNaN(until.getTime()) || until.getTime() <= Date.now())) {
      return bad(res, 'The end date must be in the future');
    }

    const u = await User.findOne({ _id: req.params.id, role: 'patient' }).select('status profile.fullName');
    if (!u) return res.status(404).json({ success: false, message: 'Patient not found' });
    const request = await DietPlanRequest.findOne({ patient: u._id }).sort({ createdAt: -1 });
    if (!request) return res.status(409).json({ success: false, message: 'This patient has no membership to extend' });

    const currentEnd = request.subscriptionExpiresAt || u.status?.subscriptionExpiresAt || null;
    const newEnd = extendedEnd(currentEnd, { days, until });
    if (currentEnd && newEnd.getTime() <= new Date(currentEnd).getTime()) {
      return bad(res, 'The new end date must be later than the current one');
    }

    await audited(
      req,
      {
        action: 'user.extend_subscription',
        targetType: 'user',
        targetId: String(u._id),
        before: { subscriptionExpiresAt: currentEnd },
        after: { subscriptionExpiresAt: newEnd },
        reason,
        meta: { days: days ?? null, until: until ?? null, name: nameOf(u) },
      },
      async () => {
        request.subscriptionExpiresAt = newEnd;
        // A fresh window: let the renewal reminder fire again before the new end.
        request.renewalReminderSentAt = null;
        await request.save();
        await User.updateOne({ _id: u._id }, { $set: { 'status.subscriptionExpiresAt': newEnd } });
      }
    );
    res.json({ success: true, data: { subscriptionExpiresAt: newEnd } });
  } catch (err) {
    next(err);
  }
};

exports.extendedEnd = extendedEnd;
