/**
 * Admin payments API end to end (openspec add-admin-panel: admin-payments).
 * Real Express app + real in-memory MongoDB; only the admin identity gate is faked.
 */
const { connectTestDb, disconnectTestDb, clearTestDb } = require('./helpers/testDb');

jest.mock('../middlewares/adminAuth', () => ({
  adminAuth: (req, res, next) => {
    req.admin = { email: 'docwellness.fit@gmail.com', user: { _id: '000000000000000000000009' }, permissions: {} };
    next();
  },
  requirePermission: () => (req, res, next) => next(),
}));

let request, app;
let createPatient, createDietician, createDietPlanRequest, createActiveDietPlan;
let ManualPaymentProof, DietPlanRequest, Notification, AdminAuditLog, User;

beforeAll(async () => {
  await connectTestDb();
  request = require('supertest');
  app = require('../config/createApp')();
  ({ createPatient, createDietician, createDietPlanRequest, createActiveDietPlan } = require('./helpers/factories'));
  ({ ManualPaymentProof, DietPlanRequest, Notification, User } = require('../models'));
  AdminAuditLog = require('../models/AdminAuditLog');
});
afterEach(async () => {
  await clearTestDb();
});
afterAll(async () => {
  await disconnectTestDb();
});

async function seed({ renewal = true, status = 'Submitted', amountReceived = 5000, amountPending = 0, image = 'https://res.cloudinary.com/x/proof.jpg' } = {}) {
  const dietician = await createDietician();
  const patient = await createPatient();
  const dpr = await createDietPlanRequest(patient, dietician, { status: 'PaymentSubmitted', membershipPlan: '3 months' });
  if (renewal) await createActiveDietPlan(patient, dietician);
  const proof = await ManualPaymentProof.create({
    request: dpr._id,
    patient: patient._id,
    amountReceived,
    amountPending,
    status,
    proofImage: image,
  });
  return { dietician, patient, dpr, proof };
}

const get = (p) => request(app).get(`/api/admin${p}`);
const post = (p, body) => request(app).post(`/api/admin${p}`).send(body || {});

describe('queue', () => {
  it('lists proofs with status counts, oldest pending first, and filters by status and patient name', async () => {
    const a = await seed();
    const b = await seed({ status: 'Approved' });
    await User.updateOne({ _id: a.patient._id }, { $set: { 'profile.fullName': 'Meera Kulkarni' } });

    const all = await get('/payments');
    expect(all.status).toBe(200);
    expect(all.body.data.total).toBe(2);
    expect(all.body.data.counts).toMatchObject({ Submitted: 1, Approved: 1 });

    const pending = await get('/payments?status=Submitted');
    expect(pending.body.data.items.map((i) => String(i._id))).toEqual([String(a.proof._id)]);

    const byName = await get('/payments?q=meera');
    expect(byName.body.data.items).toHaveLength(1);
    expect(byName.body.data.items[0].patientName).toBe('Meera Kulkarni');
    expect(b.proof).toBeTruthy();
  });
});

describe('detail', () => {
  it('returns the proof and audits that the proof image was opened', async () => {
    const { proof } = await seed();
    const r = await get(`/payments/${proof._id}`);
    expect(r.status).toBe(200);
    expect(r.body.data.proofImage).toBe('https://res.cloudinary.com/x/proof.jpg');
    expect(r.body.data.isRenewal).toBe(true);
    expect(r.body.data.canConfirm).toBe(true);
    const logs = await AdminAuditLog.find({ action: 'payment.proof_view' }).lean();
    expect(logs).toHaveLength(1);
    expect(logs[0].targetId).toBe(String(proof._id));
  });

  it('404s for an unknown payment', async () => {
    expect((await get('/payments/000000000000000000000abc')).status).toBe(404);
  });
});

describe('confirm', () => {
  it('confirms a renewal: proof approved, request paid, patient notified, audited', async () => {
    const { proof, dpr, patient } = await seed();
    const r = await post(`/payments/${proof._id}/confirm`, { note: 'Matches bank statement' });
    expect(r.status).toBe(200);
    expect(r.body.data.status).toBe('Approved');

    const req = await DietPlanRequest.findById(dpr._id);
    expect(req.status).toBe('Paid');
    expect(req.hasActivePlan).toBe(true);
    expect(req.subscriptionExpiresAt.getTime()).toBeGreaterThan(Date.now());

    const note = await Notification.findOne({ userId: patient._id, type: 'payment' });
    expect(note.title).toBe('Payment confirmed');
    const audit = await AdminAuditLog.findOne({ action: 'payment.confirm' }).lean();
    expect(audit).toMatchObject({ targetId: String(proof._id), reason: 'Matches bank statement', outcome: 'success' });
  });

  it('a partial payment leaves the request PartiallyPaid', async () => {
    const { proof, dpr } = await seed({ amountReceived: 3000, amountPending: 2000 });
    expect((await post(`/payments/${proof._id}/confirm`)).status).toBe(200);
    expect((await DietPlanRequest.findById(dpr._id)).status).toBe('PartiallyPaid');
  });

  it('refuses a first payment (no active plan) and explains why, changing nothing', async () => {
    const { proof, dpr } = await seed({ renewal: false });
    const r = await post(`/payments/${proof._id}/confirm`);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('needs_plan_activation');
    expect((await ManualPaymentProof.findById(proof._id)).status).toBe('Submitted');
    expect((await DietPlanRequest.findById(dpr._id)).status).toBe('PaymentSubmitted');
    const detail = await get(`/payments/${proof._id}`);
    expect(detail.body.data.canConfirm).toBe(false);
    expect(detail.body.data.confirmBlockedReason).toMatch(/first payment/i);
  });

  it('cannot decide a payment twice', async () => {
    const { proof } = await seed();
    expect((await post(`/payments/${proof._id}/confirm`)).status).toBe(200);
    expect((await post(`/payments/${proof._id}/confirm`)).status).toBe(409);
    expect((await post(`/payments/${proof._id}/reject`, { note: 'x' })).status).toBe(409);
  });
});

describe('reject', () => {
  it('needs a note, then rejects, notifies the patient with the note, and audits', async () => {
    const { proof, patient } = await seed();
    expect((await post(`/payments/${proof._id}/reject`, {})).status).toBe(400);
    expect((await ManualPaymentProof.findById(proof._id)).status).toBe('Submitted');

    const r = await post(`/payments/${proof._id}/reject`, { note: 'Screenshot is unreadable' });
    expect(r.status).toBe(200);
    expect(r.body.data.status).toBe('Rejected');
    expect(r.body.data.reviewNote).toBe('Screenshot is unreadable');
    const note = await Notification.findOne({ userId: patient._id, type: 'payment' });
    expect(note.message).toBe('Screenshot is unreadable');
    expect(await AdminAuditLog.countDocuments({ action: 'payment.reject' })).toBe(1);
  });
});

describe('refunds', () => {
  it('records refunds up to the amount received and refuses more', async () => {
    const { proof } = await seed({ status: 'Approved', amountReceived: 5000 });
    const when = new Date().toISOString();

    const first = await post(`/payments/${proof._id}/refunds`, { amount: 2000, reason: 'Moved city', refundedAt: when, reference: 'UTR123' });
    expect(first.status).toBe(201);
    expect(first.body.data.refundedTotal).toBe(2000);
    expect(first.body.data.refundable).toBe(3000);

    const over = await post(`/payments/${proof._id}/refunds`, { amount: 3500, reason: 'Too much', refundedAt: when });
    expect(over.status).toBe(400);
    expect(over.body.code).toBe('over_refund');

    const rest = await post(`/payments/${proof._id}/refunds`, { amount: 3000, reason: 'Rest', refundedAt: when });
    expect(rest.status).toBe(201);
    expect(rest.body.data.refundable).toBe(0);
    expect(await AdminAuditLog.countDocuments({ action: 'payment.refund' })).toBe(2);
  });

  it('only a confirmed payment can be refunded, and a reason and amount are required', async () => {
    const pending = await seed();
    expect((await post(`/payments/${pending.proof._id}/refunds`, { amount: 100, reason: 'x', refundedAt: new Date() })).status).toBe(409);
    const ok = await seed({ status: 'Approved' });
    expect((await post(`/payments/${ok.proof._id}/refunds`, { amount: 0, reason: 'x', refundedAt: new Date() })).status).toBe(400);
    expect((await post(`/payments/${ok.proof._id}/refunds`, { amount: 10, reason: '', refundedAt: new Date() })).status).toBe(400);
  });
});

describe('reconciliation', () => {
  it('flags a confirmed payment with no active plan after 24 hours, and an active plan with no confirmed payment', async () => {
    // Approved long ago, request never got an active plan.
    const stuck = await seed({ renewal: false, status: 'Approved' });
    await ManualPaymentProof.updateOne({ _id: stuck.proof._id }, { $set: { reviewedAt: new Date(Date.now() - 3 * 24 * 3600 * 1000) } });
    // Active plan but only a rejected proof behind it.
    const orphan = await seed({ status: 'Rejected' });
    await DietPlanRequest.updateOne({ _id: orphan.dpr._id }, { $set: { hasActivePlan: true } });
    // A healthy one that must not be flagged.
    const healthy = await seed({ status: 'Approved' });
    await DietPlanRequest.updateOne({ _id: healthy.dpr._id }, { $set: { hasActivePlan: true } });
    await ManualPaymentProof.updateOne({ _id: healthy.proof._id }, { $set: { reviewedAt: new Date(Date.now() - 3 * 24 * 3600 * 1000) } });

    const r = await get('/payments/reconciliation');
    expect(r.status).toBe(200);
    expect(r.body.data.confirmedWithoutPlan.count).toBe(1);
    expect(r.body.data.confirmedWithoutPlan.items[0]._id).toBe(String(stuck.proof._id));
    expect(r.body.data.activeWithoutPayment.count).toBe(1);
    expect(r.body.data.activeWithoutPayment.items[0].requestId).toBe(String(orphan.dpr._id));
  });
});
