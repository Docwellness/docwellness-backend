/**
 * Admin dieticians API (openspec add-admin-panel: admin-dietician-management).
 * Real Express app + real in-memory MongoDB; the admin gate and Supabase are faked.
 */
const { connectTestDb, disconnectTestDb, clearTestDb } = require('./helpers/testDb');

jest.mock('../middlewares/adminAuth', () => ({
  adminAuth: (req, res, next) => {
    req.admin = { email: 'docwellness.fit@gmail.com', user: { _id: '000000000000000000000009' }, permissions: {} };
    next();
  },
  requirePermission: () => (req, res, next) => next(),
}));
const mockCreateUser = jest.fn();
const mockDeleteUser = jest.fn();
jest.mock('../utils/supabaseAuth', () => ({
  ...jest.requireActual('../utils/supabaseAuth'),
  getSupabaseAdmin: () => ({ auth: { admin: { createUser: mockCreateUser, deleteUser: mockDeleteUser } } }),
}));

let request, app, f;
let User, DietPlanRequest, DietPlan, Review, Conversation, ManualPaymentProof, AdminAuditLog;

beforeAll(async () => {
  await connectTestDb();
  request = require('supertest');
  app = require('../config/createApp')();
  f = require('./helpers/factories');
  ({ User, DietPlanRequest, DietPlan, Review, Conversation, ManualPaymentProof } = require('../models'));
  AdminAuditLog = require('../models/AdminAuditLog');
});
beforeEach(() => {
  mockCreateUser.mockReset().mockResolvedValue({ data: { user: { id: 'sb-new-1' } }, error: null });
  mockDeleteUser.mockReset().mockResolvedValue({});
});
afterEach(async () => {
  await clearTestDb();
});
afterAll(async () => {
  await disconnectTestDb();
});

const get = (p) => request(app).get(`/api/admin${p}`);
const post = (p, body) => request(app).post(`/api/admin${p}`).send(body || {});

async function verifiedDietician(name = 'Dr Meera Joshi') {
  const d = await f.createDietician();
  await User.updateOne({ _id: d._id }, { $set: { 'profile.fullName': name, 'verification.status': 'verified', 'verification.licenceNumber': 'MH-1' } });
  return d;
}
async function clientOf(dietician, over = {}) {
  const patient = await f.createPatient();
  const dpr = await f.createDietPlanRequest(patient, dietician, { hasActivePlan: true, status: 'Paid', ...over });
  await DietPlan.create({ patientId: patient._id, dieticianId: dietician._id, status: 'Active', activationDate: new Date() });
  return { patient, dpr };
}

describe('create and verify', () => {
  it('creates a pending dietician with a temporary password and audits it', async () => {
    const r = await post('/dieticians', {
      fullName: 'Dr Neha Rao',
      email: 'Neha@Example.com',
      qualification: 'MSc Nutrition',
      licenceNumber: 'KA-22',
      specialisations: 'PCOS, Diabetes',
    });
    expect(r.status).toBe(201);
    expect(r.body.data.temporaryPassword.length).toBeGreaterThan(10);
    const u = await User.findOne({ email: 'neha@example.com' }).lean();
    expect(u).toMatchObject({ role: 'dietician', verification: { status: 'pending', licenceNumber: 'KA-22' } });
    expect(u.verification.specialisations).toEqual(['PCOS', 'Diabetes']);
    expect(await AdminAuditLog.countDocuments({ action: 'dietician.create' })).toBe(1);
  });

  it('rejects a missing licence, a duplicate email, and a failed login creation', async () => {
    expect((await post('/dieticians', { fullName: 'X', email: 'x@y.co', qualification: 'q' })).status).toBe(400);
    const d = await verifiedDietician();
    expect((await post('/dieticians', { fullName: 'X', email: d.email, qualification: 'q', licenceNumber: 'L' })).status).toBe(409);
    mockCreateUser.mockResolvedValueOnce({ data: null, error: { message: 'boom' } });
    expect((await post('/dieticians', { fullName: 'X', email: 'new@y.co', qualification: 'q', licenceNumber: 'L' })).status).toBe(400);
  });

  it('verifies with a licence, rejects only with a note, and audits both', async () => {
    await post('/dieticians', { fullName: 'Dr N', email: 'n@y.co', qualification: 'q', licenceNumber: 'L1' });
    const u = await User.findOne({ email: 'n@y.co' });
    expect((await post(`/dieticians/${u._id}/verification`, { status: 'rejected' })).status).toBe(400);
    expect((await post(`/dieticians/${u._id}/verification`, { status: 'rejected', note: 'Licence not found' })).status).toBe(200);
    expect((await User.findById(u._id).lean()).verification.status).toBe('rejected');
    expect((await post(`/dieticians/${u._id}/verification`, { status: 'verified' })).status).toBe(200);
    expect(await AdminAuditLog.countDocuments({ action: { $in: ['dietician.reject', 'dietician.verify'] } })).toBe(2);
  });

  it('treats dieticians that predate verification as verified, and filters by status', async () => {
    const old = await f.createDietician();
    await post('/dieticians', { fullName: 'Dr P', email: 'p@y.co', qualification: 'q', licenceNumber: 'L' });
    const verified = (await get('/dieticians?verification=verified')).body.data.items.map((i) => i._id);
    expect(verified).toContain(String(old._id));
    expect((await get('/dieticians?verification=pending')).body.data.items).toHaveLength(1);
  });
});

describe('list and detail', () => {
  it('shows client counts and a rating without hidden reviews, and masks contact details', async () => {
    const d = await verifiedDietician();
    await clientOf(d);
    const p1 = await f.createPatient();
    const p2 = await f.createPatient();
    await Review.create({ dieticianId: d._id, patientId: p1._id, rating: 5 });
    await Review.create({ dieticianId: d._id, patientId: p2._id, rating: 1, hidden: true });
    const row = (await get('/dieticians')).body.data.items[0];
    expect(row).toMatchObject({ clients: 1, activePlans: 1, averageRating: 5, reviewCount: 1 });
    expect(row.email).not.toBe(d.email);
    const detail = (await get(`/dieticians/${d._id}`)).body.data;
    expect(detail.clientsList).toHaveLength(1);
  });
});

describe('reassign', () => {
  it('moves requests, plans and the chat to the new dietician, after a dry run', async () => {
    const a = await verifiedDietician('Dr A');
    const b = await verifiedDietician('Dr B');
    const { patient } = await clientOf(a);
    await Conversation.create({ participants: [{ userId: a._id }, { userId: patient._id }] });

    const dry = await post(`/dieticians/${a._id}/reassign`, { patientIds: [patient._id], toDieticianId: b._id, dryRun: true });
    expect(dry.body.data.counts).toMatchObject({ dietPlanRequests: 1, dietPlans: 1, conversations: 1 });
    expect(await DietPlanRequest.countDocuments({ dieticianId: b._id })).toBe(0);

    expect((await post(`/dieticians/${a._id}/reassign`, { patientIds: [patient._id], toDieticianId: b._id })).status).toBe(400); // no reason
    const r = await post(`/dieticians/${a._id}/reassign`, { patientIds: [patient._id], toDieticianId: b._id, reason: 'Dr A on leave' });
    expect(r.status).toBe(200);
    expect(await DietPlanRequest.countDocuments({ dieticianId: b._id })).toBe(1);
    expect(await DietPlan.countDocuments({ dieticianId: b._id })).toBe(1);
    const conv = await Conversation.findOne().lean();
    expect(conv.participants.map((p) => String(p.userId))).toEqual([String(b._id), String(patient._id)]);
    expect(await AdminAuditLog.countDocuments({ action: 'dietician.reassign_clients' })).toBe(1);
  });

  it('refuses a target that is unverified, suspended or the same, and clients that are not theirs', async () => {
    const a = await verifiedDietician();
    const pending = await f.createDietician();
    await User.updateOne({ _id: pending._id }, { $set: { 'verification.status': 'pending' } });
    const suspended = await verifiedDietician('S');
    await User.updateOne({ _id: suspended._id }, { $set: { isActive: false } });
    const b = await verifiedDietician('B');
    const { patient } = await clientOf(a);
    const other = await f.createPatient();
    const body = (to, ids = [patient._id]) => ({ patientIds: ids, toDieticianId: to, reason: 'x' });
    expect((await post(`/dieticians/${a._id}/reassign`, body(pending._id))).status).toBe(400);
    expect((await post(`/dieticians/${a._id}/reassign`, body(suspended._id))).status).toBe(400);
    expect((await post(`/dieticians/${a._id}/reassign`, body(a._id))).status).toBe(400);
    expect((await post(`/dieticians/${a._id}/reassign`, body(b._id, [other._id]))).status).toBe(400);
  });
});

describe('suspend', () => {
  it('requires a reason and a client decision when clients are active', async () => {
    const a = await verifiedDietician();
    await clientOf(a);
    expect((await post(`/dieticians/${a._id}/suspend`, {})).status).toBe(400);
    const r = await post(`/dieticians/${a._id}/suspend`, { reason: 'Complaint' });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('client_action_required');
    expect((await User.findById(a._id).lean()).isActive).not.toBe(false);
  });

  it('can flag clients for reassignment, or reassign them, and can reactivate', async () => {
    const a = await verifiedDietician();
    const b = await verifiedDietician('B');
    const c1 = await clientOf(a);
    expect((await post(`/dieticians/${a._id}/suspend`, { reason: 'Review', clientAction: 'flag' })).status).toBe(200);
    expect((await DietPlanRequest.findById(c1.dpr._id).lean()).needsReassignment).toBe(true);
    const row = (await get('/dieticians')).body.data.items.find((i) => i._id === String(a._id));
    expect(row.flaggedForReassignment).toBe(1);
    expect((await post(`/dieticians/${a._id}/reactivate`, { reason: 'Cleared' })).status).toBe(200);

    expect((await post(`/dieticians/${a._id}/suspend`, { reason: 'Again', clientAction: 'reassign' })).status).toBe(400); // no target
    expect((await post(`/dieticians/${a._id}/suspend`, { reason: 'Again', clientAction: 'reassign', toDieticianId: b._id })).status).toBe(200);
    expect(await DietPlanRequest.countDocuments({ dieticianId: b._id })).toBe(1);
    expect((await User.findById(a._id).lean()).isActive).toBe(false);
  });

  it('suspends without a decision when there are no active clients', async () => {
    const a = await verifiedDietician();
    expect((await post(`/dieticians/${a._id}/suspend`, { reason: 'Left' })).status).toBe(200);
  });
});

describe('reviews', () => {
  it('hides a review with a reason and can unhide it', async () => {
    const a = await verifiedDietician();
    const p = await f.createPatient();
    const rv = await Review.create({ dieticianId: a._id, patientId: p._id, rating: 2, text: 'abusive' });
    expect((await post(`/dieticians/${a._id}/reviews/${rv._id}/hide`, {})).status).toBe(400);
    expect((await post(`/dieticians/${a._id}/reviews/${rv._id}/hide`, { reason: 'Abusive language' })).status).toBe(200);
    expect((await get(`/dieticians/${a._id}/reviews`)).body.data[0]).toMatchObject({ hidden: true, hiddenReason: 'Abusive language' });
    expect((await post(`/dieticians/${a._id}/reviews/${rv._id}/unhide`, {})).status).toBe(200);
    expect(await AdminAuditLog.countDocuments({ action: { $in: ['dietician.review_hide', 'dietician.review_unhide'] } })).toBe(2);
  });
});

describe('earnings', () => {
  it('sums confirmed payments from their clients net of refunds', async () => {
    const a = await verifiedDietician();
    const { patient, dpr } = await clientOf(a);
    const PaymentRefund = require('../models/PaymentRefund');
    const proof = await ManualPaymentProof.create({
      request: dpr._id,
      patient: patient._id,
      amountReceived: 9000,
      amountPending: 0,
      status: 'Approved',
      reviewedAt: new Date(),
    });
    await PaymentRefund.create({ proof: proof._id, request: dpr._id, patient: patient._id, amount: 1000, reason: 'x', refundedAt: new Date(), refundedBy: 'a@b.c' });
    const r = (await get(`/dieticians/${a._id}/earnings`)).body.data;
    expect(r).toMatchObject({ payments: 1, revenue: 9000, refunded: 1000, net: 8000 });
  });
});
