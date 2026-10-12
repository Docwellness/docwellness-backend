const mongoose = require('mongoose');
const { User, DietPlanRequest, ManualPaymentProof } = require('../../models');
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

function presentRow(u) {
  return {
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
    res.json({ success: true, data: { items: rows.map(presentRow), total, page, limit } });
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

    const [request, proofs] = await Promise.all([
      DietPlanRequest.findOne({ patient: u._id }).sort({ createdAt: -1 }).lean(),
      ManualPaymentProof.find({ patient: u._id }).sort({ createdAt: -1 }).limit(5).select('status amountReceived createdAt').lean(),
    ]);
    const dietician = request?.dieticianId ? await User.findById(request.dieticianId).select('profile.fullName').lean() : null;

    res.json({
      success: true,
      data: {
        ...presentRow(u),
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
              startedAt: request.subscriptionStartDate || null,
              expiresAt: request.subscriptionExpiresAt || u.status?.subscriptionExpiresAt || null,
            }
          : null,
        recentPayments: proofs.map((p) => ({ _id: p._id, status: p.status, amount: p.amountReceived, createdAt: p.createdAt })),
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
