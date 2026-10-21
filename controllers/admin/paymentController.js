const mongoose = require('mongoose');
const { ManualPaymentProof, DietPlan, DietPlanRequest, User, Notification } = require('../../models');
const PaymentRefund = require('../../models/PaymentRefund');
const { audited, writeAudit } = require('../../utils/adminAudit');
const { settleRenewalProof } = require('../../utils/paymentSettlement');
const { resolveText } = require('../../utils/notificationRules');

const bad = (res, message, extra = {}) => res.status(400).json({ success: false, message, ...extra });
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const DECIDABLE = ['Submitted', 'Reviewed'];
const ALL_STATUSES = ['Submitted', 'Reviewed', 'Approved', 'Rejected'];

const nameOf = (u) => u?.profile?.fullName || '';

async function refundsFor(proofIds) {
  if (!proofIds.length) return new Map();
  const rows = await PaymentRefund.find({ proof: { $in: proofIds } }).sort({ refundedAt: -1 }).lean();
  const map = new Map();
  rows.forEach((r) => {
    const k = String(r.proof);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(r);
  });
  return map;
}

const refundedTotal = (list = []) => list.reduce((sum, r) => sum + (r.amount || 0), 0);

/** Notifies the patient in-app. Never blocks or fails the decision itself. */
async function notifyPatient(proof, request, title, message, ruleKey) {
  try {
    await Notification.create({
      userId: proof.patient,
      title,
      message,
      type: 'payment',
      referenceId: request?._id,
      referenceModel: request ? 'DietPlanRequest' : undefined,
      data: ruleKey ? { ruleKey } : undefined,
    });
  } catch (err) {
    console.error('admin payment notification failed:', err.message);
  }
}

// GET /api/admin/payments?status=&q=&from=&to=&page=&limit=
exports.listPayments = async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 25));
    const filter = {};
    if (ALL_STATUSES.includes(req.query.status)) filter.status = req.query.status;
    if (req.query.from || req.query.to) {
      filter.createdAt = {};
      if (req.query.from) filter.createdAt.$gte = new Date(req.query.from);
      if (req.query.to) filter.createdAt.$lte = new Date(req.query.to);
    }
    const q = String(req.query.q || '').trim();
    if (q) {
      const rx = new RegExp(escapeRegex(q.slice(0, 80)), 'i');
      const people = await User.find({ role: 'patient', 'profile.fullName': rx }).select('_id').limit(200).lean();
      filter.patient = { $in: people.map((p) => p._id) };
    }

    // Oldest pending first for the queue, newest first for everything else.
    const sort = filter.status === 'Submitted' ? { createdAt: 1 } : { createdAt: -1 };
    const [rows, total, counts] = await Promise.all([
      ManualPaymentProof.find(filter)
        .sort(sort)
        .skip((page - 1) * limit)
        .limit(limit)
        .populate('patient', 'profile.fullName')
        .populate('request', 'membershipPlan dieticianId hasActivePlan')
        .lean(),
      ManualPaymentProof.countDocuments(filter),
      ManualPaymentProof.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]),
    ]);

    const dieticianIds = [...new Set(rows.map((r) => String(r.request?.dieticianId || '')).filter(Boolean))];
    const dieticians = await User.find({ _id: { $in: dieticianIds } }).select('profile.fullName').lean();
    const dName = new Map(dieticians.map((d) => [String(d._id), nameOf(d)]));
    const refunds = await refundsFor(rows.map((r) => r._id));

    res.json({
      success: true,
      data: {
        items: rows.map((r) => ({
          _id: r._id,
          patientName: nameOf(r.patient),
          dieticianName: dName.get(String(r.request?.dieticianId)) || '',
          plan: r.request?.membershipPlan || '',
          amountReceived: r.amountReceived,
          amountPending: r.amountPending,
          totalAmount: r.totalAmount,
          couponCode: r.couponCode || null,
          status: r.status,
          refunded: refundedTotal(refunds.get(String(r._id))),
          createdAt: r.createdAt,
          reviewedAt: r.reviewedAt || null,
        })),
        total,
        page,
        limit,
        counts: Object.fromEntries(counts.map((c) => [c._id, c.n])),
      },
    });
  } catch (err) {
    next(err);
  }
};

async function loadDetail(id) {
  const proof = await ManualPaymentProof.findById(id)
    .populate('patient', 'profile.fullName')
    .populate('request')
    .lean();
  if (!proof) return null;
  const dietician = proof.request?.dieticianId
    ? await User.findById(proof.request.dieticianId).select('profile.fullName').lean()
    : null;
  const hasActivePlan = proof.patient?._id
    ? Boolean(await DietPlan.exists({ patientId: proof.patient._id, status: 'Active' }))
    : false;
  const refunds = (await refundsFor([proof._id])).get(String(proof._id)) || [];
  const reviewer = proof.reviewedBy ? await User.findById(proof.reviewedBy).select('profile.fullName email').lean() : null;
  return { proof, dietician, hasActivePlan, refunds, reviewer };
}

function present({ proof, dietician, hasActivePlan, refunds, reviewer }) {
  const refunded = refundedTotal(refunds);
  const isRenewal = hasActivePlan;
  const canDecide = DECIDABLE.includes(proof.status);
  return {
    _id: proof._id,
    status: proof.status,
    patient: { _id: proof.patient?._id, name: nameOf(proof.patient) },
    dieticianName: nameOf(dietician),
    request: proof.request
      ? {
          _id: proof.request._id,
          plan: proof.request.membershipPlan || '',
          planAmount: proof.request.membershipAmount ?? null,
          status: proof.request.status,
          hasActivePlan: Boolean(proof.request.hasActivePlan),
          subscriptionExpiresAt: proof.request.subscriptionExpiresAt || null,
        }
      : null,
    amountReceived: proof.amountReceived,
    amountPending: proof.amountPending,
    totalAmount: proof.totalAmount,
    couponCode: proof.couponCode || null,
    discountPercentage: proof.discountPercentage || null,
    originalAmount: proof.originalAmount || null,
    pendingPaymentDate: proof.pendingPaymentDate || null,
    description: proof.description || '',
    proofImage: proof.proofImage || null,
    reviewNote: proof.reviewNote || '',
    reviewedAt: proof.reviewedAt || null,
    reviewedByName: reviewer ? nameOf(reviewer) || reviewer.email : '',
    createdAt: proof.createdAt,
    isRenewal,
    // Confirming a first payment is done by building and activating the diet
    // plan, which the dietician does when the plan is ready.
    canConfirm: canDecide && isRenewal,
    confirmBlockedReason:
      canDecide && !isRenewal
        ? 'This is a first payment. It is confirmed when the dietician activates the diet plan.'
        : null,
    canReject: canDecide,
    canRefund: proof.status === 'Approved',
    refunds: refunds.map((r) => ({
      _id: r._id,
      amount: r.amount,
      reason: r.reason,
      refundedAt: r.refundedAt,
      reference: r.reference || '',
      recordedBy: r.recordedBy || '',
    })),
    refundedTotal: refunded,
    refundable: proof.status === 'Approved' ? Math.max(0, (proof.amountReceived || 0) - refunded) : 0,
  };
}

// GET /api/admin/payments/:id   (opening the proof is itself audited)
exports.getPayment = async (req, res, next) => {
  try {
    const detail = await loadDetail(req.params.id);
    if (!detail) return res.status(404).json({ success: false, message: 'Payment not found' });
    if (detail.proof.proofImage) {
      await writeAudit(req, {
        action: 'payment.proof_view',
        targetType: 'payment',
        targetId: String(detail.proof._id),
      });
    }
    res.json({ success: true, data: present(detail) });
  } catch (err) {
    next(err);
  }
};

// POST /api/admin/payments/:id/confirm   { note? }
exports.confirmPayment = async (req, res, next) => {
  try {
    const proof = await ManualPaymentProof.findById(req.params.id);
    if (!proof) return res.status(404).json({ success: false, message: 'Payment not found' });
    if (!DECIDABLE.includes(proof.status)) {
      return res.status(409).json({ success: false, message: `This payment is already ${proof.status.toLowerCase()}` });
    }
    const hasActivePlan = await DietPlan.exists({ patientId: proof.patient, status: 'Active' });
    if (!hasActivePlan) {
      return res.status(409).json({
        success: false,
        code: 'needs_plan_activation',
        message: 'This is a first payment. It is confirmed when the dietician activates the diet plan.',
      });
    }
    const request = await DietPlanRequest.findById(proof.request);
    if (!request) return res.status(404).json({ success: false, message: 'The plan request for this payment is missing' });

    const note = String(req.body?.note || '').trim();
    await audited(
      req,
      {
        action: 'payment.confirm',
        targetType: 'payment',
        targetId: String(proof._id),
        before: { status: proof.status, requestStatus: request.status },
        after: { status: 'Approved' },
        reason: note || undefined,
        meta: { amountReceived: proof.amountReceived, amountPending: proof.amountPending },
      },
      async () => {
        if (note) proof.reviewNote = note;
        await settleRenewalProof({ proof, request, patientId: proof.patient, reviewerId: req.admin.user._id });
      }
    );
    const confirmed = await resolveText('payment_confirmed');
    await notifyPatient(proof, request, confirmed.title, confirmed.message, 'payment_confirmed');
    res.json({ success: true, data: present(await loadDetail(proof._id)) });
  } catch (err) {
    next(err);
  }
};

// POST /api/admin/payments/:id/reject   { note }  (the note is shown to the patient)
exports.rejectPayment = async (req, res, next) => {
  try {
    const note = String(req.body?.note || '').trim();
    if (!note) return bad(res, 'A note is required, it is shown to the patient');
    const proof = await ManualPaymentProof.findById(req.params.id);
    if (!proof) return res.status(404).json({ success: false, message: 'Payment not found' });
    if (!DECIDABLE.includes(proof.status)) {
      return res.status(409).json({ success: false, message: `This payment is already ${proof.status.toLowerCase()}` });
    }
    await audited(
      req,
      {
        action: 'payment.reject',
        targetType: 'payment',
        targetId: String(proof._id),
        before: { status: proof.status },
        after: { status: 'Rejected' },
        reason: note,
      },
      async () => {
        proof.status = 'Rejected';
        proof.reviewedBy = req.admin.user._id;
        proof.reviewedAt = new Date();
        proof.reviewNote = note;
        await proof.save();
      }
    );
    const request = await DietPlanRequest.findById(proof.request).select('_id').lean();
    await notifyPatient(proof, request, 'Payment not accepted', note);
    res.json({ success: true, data: present(await loadDetail(proof._id)) });
  } catch (err) {
    next(err);
  }
};

// POST /api/admin/payments/:id/refunds   { amount, reason, refundedAt, reference? }
exports.addRefund = async (req, res, next) => {
  try {
    const proof = await ManualPaymentProof.findById(req.params.id);
    if (!proof) return res.status(404).json({ success: false, message: 'Payment not found' });
    if (proof.status !== 'Approved') return res.status(409).json({ success: false, message: 'Only a confirmed payment can be refunded' });

    const amount = Number(req.body?.amount);
    const reason = String(req.body?.reason || '').trim();
    const refundedAt = new Date(req.body?.refundedAt);
    if (!Number.isFinite(amount) || amount <= 0) return bad(res, 'Enter the refund amount');
    if (!reason) return bad(res, 'A reason is required');
    if (Number.isNaN(refundedAt.getTime())) return bad(res, 'Choose the refund date');

    const existing = (await refundsFor([proof._id])).get(String(proof._id)) || [];
    const room = (proof.amountReceived || 0) - refundedTotal(existing);
    if (amount > room + 1e-9) {
      return res.status(400).json({
        success: false,
        code: 'over_refund',
        message: `The refund cannot be more than ${room} (the amount received minus earlier refunds)`,
      });
    }

    const refund = new PaymentRefund({
      proof: proof._id,
      patient: proof.patient,
      amount,
      reason,
      refundedAt,
      reference: String(req.body?.reference || '').trim() || undefined,
      recordedBy: req.admin.email,
    });
    await audited(
      req,
      {
        action: 'payment.refund',
        targetType: 'payment',
        targetId: String(proof._id),
        after: { amount, reference: refund.reference },
        reason,
      },
      () => refund.save()
    );
    res.status(201).json({ success: true, data: present(await loadDetail(proof._id)) });
  } catch (err) {
    next(err);
  }
};

// GET /api/admin/payments/reconciliation
exports.reconciliation = async (req, res, next) => {
  try {
    const dayAgo = new Date(Date.now() - 24 * 3600 * 1000);

    // Confirmed payments whose request still has no active plan after 24 h.
    const approved = await ManualPaymentProof.find({ status: 'Approved', reviewedAt: { $lt: dayAgo } })
      .sort({ reviewedAt: -1 })
      .limit(500)
      .populate('patient', 'profile.fullName')
      .populate('request', 'hasActivePlan membershipPlan')
      .lean();
    const noPlan = approved.filter((p) => !p.request?.hasActivePlan);

    // Active plans with no confirmed payment behind them.
    const active = await DietPlanRequest.find({ hasActivePlan: true })
      .select('patient membershipPlan subscriptionExpiresAt')
      .populate('patient', 'profile.fullName')
      .limit(1000)
      .lean();
    const paid = new Set(
      (
        await ManualPaymentProof.find({ status: 'Approved', request: { $in: active.map((a) => a._id) } })
          .select('request')
          .lean()
      ).map((p) => String(p.request))
    );
    const noPayment = active.filter((a) => !paid.has(String(a._id)));

    res.json({
      success: true,
      data: {
        confirmedWithoutPlan: {
          count: noPlan.length,
          items: noPlan.slice(0, 50).map((p) => ({
            _id: p._id,
            patientName: nameOf(p.patient),
            plan: p.request?.membershipPlan || '',
            amountReceived: p.amountReceived,
            reviewedAt: p.reviewedAt,
          })),
        },
        activeWithoutPayment: {
          count: noPayment.length,
          items: noPayment.slice(0, 50).map((a) => ({
            requestId: a._id,
            patientName: nameOf(a.patient),
            plan: a.membershipPlan || '',
            subscriptionExpiresAt: a.subscriptionExpiresAt || null,
          })),
        },
      },
    });
  } catch (err) {
    next(err);
  }
};


