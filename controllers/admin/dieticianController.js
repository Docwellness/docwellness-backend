const crypto = require('crypto');
const mongoose = require('mongoose');
const { User, DietPlanRequest, ManualPaymentProof, Review } = require('../../models');
const PaymentRefund = require('../../models/PaymentRefund');
const { getSupabaseAdmin } = require('../../utils/supabaseAuth');
const { audited } = require('../../utils/adminAudit');
const { reassignPatients } = require('../../utils/dieticianReassign');
const { maskPhone, maskEmail } = require('../../utils/piiMask');

const bad = (res, message, extra = {}) => res.status(400).json({ success: false, message, ...extra });
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isId = (v) => mongoose.Types.ObjectId.isValid(String(v));
const nameOf = (u) => u?.profile?.fullName || '';
const statusOf = (u) => u?.verification?.status || 'verified';

const LIST_FIELDS = 'profile.fullName profile.whatsappNumber email isActive lastLogin createdAt verification';

async function statsFor(ids) {
  const [clients, ratings] = await Promise.all([
    DietPlanRequest.aggregate([
      { $match: { dieticianId: { $in: ids } } },
      {
        $group: {
          _id: '$dieticianId',
          patients: { $addToSet: '$patient' },
          active: { $sum: { $cond: [{ $eq: ['$hasActivePlan', true] }, 1, 0] } },
          flagged: { $sum: { $cond: [{ $eq: ['$needsReassignment', true] }, 1, 0] } },
        },
      },
    ]),
    Review.aggregate([
      { $match: { dieticianId: { $in: ids }, hidden: { $ne: true } } },
      { $group: { _id: '$dieticianId', avg: { $avg: '$rating' }, count: { $sum: 1 } } },
    ]),
  ]);
  const byClient = new Map(clients.map((c) => [String(c._id), c]));
  const byRating = new Map(ratings.map((r) => [String(r._id), r]));
  return (id) => {
    const c = byClient.get(String(id));
    const r = byRating.get(String(id));
    return {
      clients: c ? c.patients.length : 0,
      activePlans: c ? c.active : 0,
      flaggedForReassignment: c ? c.flagged : 0,
      averageRating: r ? Math.round(r.avg * 10) / 10 : null,
      reviewCount: r ? r.count : 0,
    };
  };
}

function present(u, stats) {
  return {
    _id: u._id,
    name: nameOf(u),
    email: maskEmail(u.email),
    phone: maskPhone(u.profile?.whatsappNumber || ''),
    isActive: u.isActive !== false,
    verification: statusOf(u),
    licenceNumber: u.verification?.licenceNumber || '',
    qualification: u.verification?.qualification || u.dieticianProfile?.qualification || '',
    specialisations: u.verification?.specialisations || [],
    languages: u.verification?.languages || [],
    verificationNote: u.verification?.note || '',
    decidedBy: u.verification?.decidedBy || '',
    decidedAt: u.verification?.decidedAt || null,
    lastLogin: u.lastLogin || null,
    createdAt: u.createdAt,
    ...stats,
  };
}

// GET /api/admin/dieticians?q=&verification=&account=&page=&limit=
exports.listDieticians = async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 25));
    const and = [{ role: 'dietician' }];
    const q = String(req.query.q || '').trim().slice(0, 80);
    if (q) {
      const rx = new RegExp(escapeRegex(q), 'i');
      and.push({ $or: [{ 'profile.fullName': rx }, { email: rx }, { 'profile.whatsappNumber': rx }] });
    }
    if (['pending', 'rejected'].includes(req.query.verification)) and.push({ 'verification.status': req.query.verification });
    if (req.query.verification === 'verified') {
      and.push({ $or: [{ 'verification.status': 'verified' }, { 'verification.status': { $exists: false } }] });
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
    const stat = await statsFor(rows.map((r) => r._id));
    res.json({ success: true, data: { items: rows.map((r) => present(r, stat(r._id))), total, page, limit } });
  } catch (err) {
    next(err);
  }
};

// GET /api/admin/dieticians/:id
exports.getDietician = async (req, res, next) => {
  try {
    const u = await User.findOne({ _id: req.params.id, role: 'dietician' }).select(`${LIST_FIELDS} dieticianProfile.qualification`).lean();
    if (!u) return res.status(404).json({ success: false, message: 'Dietician not found' });
    const stat = await statsFor([u._id]);

    const requests = await DietPlanRequest.find({ dieticianId: u._id })
      .sort({ createdAt: -1 })
      .limit(500)
      .select('patient hasActivePlan status membershipPlan needsReassignment createdAt')
      .lean();
    const latest = new Map();
    requests.forEach((r) => {
      if (!latest.has(String(r.patient))) latest.set(String(r.patient), r);
    });
    const people = await User.find({ _id: { $in: [...latest.keys()] } }).select('profile.fullName').lean();
    const pName = new Map(people.map((p) => [String(p._id), nameOf(p)]));

    res.json({
      success: true,
      data: {
        ...present(u, stat(u._id)),
        clientsList: [...latest.values()].slice(0, 100).map((r) => ({
          patientId: r.patient,
          name: pName.get(String(r.patient)) || '',
          active: Boolean(r.hasActivePlan),
          plan: r.membershipPlan || '',
          status: r.status,
          needsReassignment: Boolean(r.needsReassignment),
        })),
      },
    });
  } catch (err) {
    next(err);
  }
};

// POST /api/admin/dieticians  { fullName, email, phone?, qualification, licenceNumber, specialisations?, languages? }
exports.createDietician = async (req, res, next) => {
  let supabaseId = null;
  try {
    const b = req.body || {};
    const fullName = String(b.fullName || '').trim();
    const email = String(b.email || '').trim().toLowerCase();
    const qualification = String(b.qualification || '').trim();
    const licenceNumber = String(b.licenceNumber || '').trim();
    if (!fullName) return bad(res, 'Enter the full name');
    if (!/^\S+@\S+\.\S+$/.test(email)) return bad(res, 'Enter a valid email');
    if (!qualification) return bad(res, 'Enter the qualification');
    if (!licenceNumber) return bad(res, 'Enter the registration or licence number');
    if (await User.exists({ email })) return res.status(409).json({ success: false, message: 'An account with this email already exists' });

    const list = (v) => (Array.isArray(v) ? v : String(v || '').split(',')).map((x) => String(x).trim()).filter(Boolean);
    // Shown to the admin once, to hand over. The dietician changes it after first sign-in.
    const temporaryPassword = `${crypto.randomBytes(9).toString('base64url')}#9`;

    const { data, error } = await getSupabaseAdmin().auth.admin.createUser({ email, password: temporaryPassword, email_confirm: true });
    if (error) return res.status(400).json({ success: false, message: `Could not create the login: ${error.message}` });
    supabaseId = data.user.id;

    const user = new User({
      supabaseUserId: supabaseId,
      email,
      role: 'dietician',
      profile: { fullName, whatsappNumber: String(b.phone || '').trim() || undefined },
      healthProfile: { bmi: 0, weightIndex: 0 },
      isVerified: true,
      verification: {
        status: 'pending',
        licenceNumber,
        qualification,
        specialisations: list(b.specialisations),
        languages: list(b.languages),
      },
    });

    await audited(
      req,
      {
        action: 'dietician.create',
        targetType: 'dietician',
        targetId: String(user._id),
        after: { fullName, email, licenceNumber, qualification },
      },
      () => user.save()
    );
    res.status(201).json({ success: true, data: { _id: user._id, email, temporaryPassword } });
  } catch (err) {
    if (supabaseId) await getSupabaseAdmin().auth.admin.deleteUser(supabaseId).catch(() => {});
    next(err);
  }
};

// POST /api/admin/dieticians/:id/verification  { status: 'verified'|'rejected'|'pending', note?, licenceNumber? }
exports.setVerification = async (req, res, next) => {
  try {
    const status = req.body?.status;
    if (!['verified', 'rejected', 'pending'].includes(status)) return bad(res, 'Choose verified, rejected or pending');
    const note = String(req.body?.note || '').trim();
    if (status === 'rejected' && !note) return bad(res, 'A decision note is required to reject');

    const u = await User.findOne({ _id: req.params.id, role: 'dietician' });
    if (!u) return res.status(404).json({ success: false, message: 'Dietician not found' });
    const before = { status: statusOf(u), licenceNumber: u.verification?.licenceNumber || '' };
    if (status === 'verified' && !(req.body?.licenceNumber || u.verification?.licenceNumber)) {
      return bad(res, 'Record the licence number before verifying');
    }

    await audited(
      req,
      {
        action: `dietician.${status === 'verified' ? 'verify' : status === 'rejected' ? 'reject' : 'unverify'}`,
        targetType: 'dietician',
        targetId: String(u._id),
        before,
        after: { status },
        reason: note || undefined,
      },
      async () => {
        u.verification = {
          ...(u.verification?.toObject?.() || u.verification || {}),
          status,
          note: note || undefined,
          licenceNumber: String(req.body?.licenceNumber || u.verification?.licenceNumber || '').trim() || undefined,
          decidedBy: req.admin.email,
          decidedAt: new Date(),
        };
        await u.save();
      }
    );
    res.json({ success: true, data: { _id: u._id, verification: status } });
  } catch (err) {
    next(err);
  }
};

async function assertAssignable(toId, fromId) {
  if (!isId(toId)) return 'Choose a dietician to move the clients to';
  if (String(toId) === String(fromId)) return 'Choose a different dietician';
  const to = await User.findOne({ _id: toId, role: 'dietician' }).select('isActive verification').lean();
  if (!to) return 'The dietician to move the clients to was not found';
  if (to.isActive === false) return 'The dietician to move the clients to is suspended';
  if (statusOf(to) !== 'verified') return 'Clients can only be moved to a verified dietician';
  return null;
}

// POST /api/admin/dieticians/:id/reassign  { patientIds, toDieticianId, reason, dryRun? }
exports.reassign = async (req, res, next) => {
  try {
    const { patientIds, toDieticianId, dryRun } = req.body || {};
    const reason = String(req.body?.reason || '').trim();
    const from = req.params.id;
    if (!Array.isArray(patientIds) || patientIds.length === 0 || patientIds.some((p) => !isId(p))) return bad(res, 'Choose at least one client');
    if (!dryRun && !reason) return bad(res, 'A reason is required');
    const err = await assertAssignable(toDieticianId, from);
    if (err) return bad(res, err);

    const owned = await DietPlanRequest.distinct('patient', { dieticianId: from, patient: { $in: patientIds } });
    if (owned.length !== new Set(patientIds.map(String)).size) return bad(res, 'One of those clients does not belong to this dietician');

    if (dryRun) {
      return res.json({ success: true, data: { dryRun: true, clients: owned.length, counts: await reassignPatients({ patientIds, fromId: from, toId: toDieticianId, dryRun: true }) } });
    }
    let counts;
    await audited(
      req,
      {
        action: 'dietician.reassign_clients',
        targetType: 'dietician',
        targetId: String(from),
        after: { toDieticianId, patientIds },
        reason,
      },
      async () => {
        counts = await reassignPatients({ patientIds, fromId: from, toId: toDieticianId });
      }
    );
    res.json({ success: true, data: { clients: owned.length, counts } });
  } catch (err) {
    next(err);
  }
};

async function setActive(req, res, next, active) {
  try {
    const reason = String(req.body?.reason || '').trim();
    if (!reason) return bad(res, 'A reason is required');
    const u = await User.findOne({ _id: req.params.id, role: 'dietician' });
    if (!u) return res.status(404).json({ success: false, message: 'Dietician not found' });
    if ((u.isActive !== false) === active) {
      return res.status(409).json({ success: false, message: active ? 'This account is already active' : 'This account is already suspended' });
    }

    let clientAction = null;
    let activeClients = [];
    if (!active) {
      activeClients = await DietPlanRequest.distinct('patient', { dieticianId: u._id, hasActivePlan: true });
      if (activeClients.length > 0) {
        clientAction = req.body?.clientAction;
        if (!['reassign', 'flag'].includes(clientAction)) {
          return res.status(409).json({
            success: false,
            code: 'client_action_required',
            message: `This dietician has ${activeClients.length} active client${activeClients.length === 1 ? '' : 's'}. Choose to reassign them or leave them flagged.`,
            activeClients: activeClients.length,
          });
        }
        if (clientAction === 'reassign') {
          const err = await assertAssignable(req.body?.toDieticianId, u._id);
          if (err) return bad(res, err);
        }
      }
    }

    await audited(
      req,
      {
        action: active ? 'dietician.reactivate' : 'dietician.suspend',
        targetType: 'dietician',
        targetId: String(u._id),
        before: { isActive: !active },
        after: { isActive: active, clientAction, activeClients: activeClients.length },
        reason,
      },
      async () => {
        if (!active && clientAction === 'reassign') {
          await reassignPatients({ patientIds: activeClients, fromId: u._id, toId: req.body.toDieticianId });
        }
        if (!active && clientAction === 'flag') {
          await DietPlanRequest.updateMany({ dieticianId: u._id, hasActivePlan: true }, { $set: { needsReassignment: true } });
        }
        u.isActive = active;
        await u.save();
      }
    );
    res.json({ success: true, data: { _id: u._id, isActive: active, clientAction, movedOrFlagged: activeClients.length } });
  } catch (err) {
    next(err);
  }
}
exports.suspend = (req, res, next) => setActive(req, res, next, false);
exports.reactivate = (req, res, next) => setActive(req, res, next, true);

// GET /api/admin/dieticians/:id/reviews
exports.listReviews = async (req, res, next) => {
  try {
    const rows = await Review.find({ dieticianId: req.params.id }).sort({ createdAt: -1 }).limit(200).lean();
    res.json({
      success: true,
      data: rows.map((r) => ({
        _id: r._id,
        patientName: r.patientName,
        rating: r.rating,
        text: r.text,
        createdAt: r.createdAt,
        hidden: Boolean(r.hidden),
        hiddenReason: r.hiddenReason || '',
      })),
    });
  } catch (err) {
    next(err);
  }
};

async function setHidden(req, res, next, hidden) {
  try {
    const { id, reviewId } = req.params;
    if (!isId(reviewId)) return bad(res, 'Invalid review');
    const reason = String(req.body?.reason || '').trim();
    if (hidden && !reason) return bad(res, 'A reason is required to hide a review');
    const review = await Review.findOne({ _id: reviewId, dieticianId: id });
    if (!review) return res.status(404).json({ success: false, message: 'Review not found' });
    if (Boolean(review.hidden) === hidden) return res.status(409).json({ success: false, message: hidden ? 'Already hidden' : 'Not hidden' });
    await audited(
      req,
      {
        action: hidden ? 'dietician.review_hide' : 'dietician.review_unhide',
        targetType: 'review',
        targetId: String(review._id),
        before: { hidden: !hidden },
        after: { hidden },
        reason: reason || undefined,
        meta: { dieticianId: id, rating: review.rating },
      },
      async () => {
        review.hidden = hidden;
        review.hiddenReason = hidden ? reason : undefined;
        review.hiddenAt = hidden ? new Date() : undefined;
        review.hiddenBy = hidden ? req.admin.email : undefined;
        await review.save();
      }
    );
    res.json({ success: true, data: { _id: review._id, hidden } });
  } catch (err) {
    next(err);
  }
}
exports.hideReview = (req, res, next) => setHidden(req, res, next, true);
exports.unhideReview = (req, res, next) => setHidden(req, res, next, false);

// GET /api/admin/dieticians/:id/earnings?from=&to=   (confirmed payments from this dietician's clients, net of refunds)
exports.earnings = async (req, res, next) => {
  try {
    const from = req.query.from ? new Date(req.query.from) : new Date(Date.now() - 30 * 24 * 3600 * 1000);
    const to = req.query.to ? new Date(req.query.to) : new Date();
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return bad(res, 'Invalid dates');

    const requestIds = await DietPlanRequest.distinct('_id', { dieticianId: req.params.id });
    const proofs = await ManualPaymentProof.find({ request: { $in: requestIds }, status: 'Approved', reviewedAt: { $gte: from, $lte: to } })
      .select('amountReceived')
      .lean();
    const allProofIds = await ManualPaymentProof.distinct('_id', { request: { $in: requestIds }, status: 'Approved' });
    const refunds = await PaymentRefund.find({ proof: { $in: allProofIds }, refundedAt: { $gte: from, $lte: to } }).select('amount').lean();

    const revenue = proofs.reduce((s, p) => s + (p.amountReceived || 0), 0);
    const refunded = refunds.reduce((s, r) => s + (r.amount || 0), 0);
    res.json({ success: true, data: { from, to, payments: proofs.length, revenue, refunded, net: revenue - refunded } });
  } catch (err) {
    next(err);
  }
};
