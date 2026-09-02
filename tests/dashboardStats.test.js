/**
 * Characterization + regression tests for the dietician dashboard stat
 * endpoints - cross-app performance optimization, Phase 2 (tasks 2.2 / 2.3).
 *
 * These endpoints had NO test coverage before the Phase 2 query rewrite
 * (parallelized reads, NeedAttentionLog write moved off the GET). The tests
 * below pin the response contract so the rewrite is provably behaviour-
 * preserving.
 */

const { connectTestDb, disconnectTestDb, clearTestDb } = require('./helpers/testDb');

jest.mock('../utils/supabaseAuth');
const { registerTestToken, clearTestTokens } = require('../utils/supabaseAuth');

let request;
let app;
let createPatient;
let createDietician;
let createDietPlanRequest;
let createActiveDietPlan;
let MealLog;
let ManualPaymentProof;
let NeedAttentionLog;

beforeAll(async () => {
  await connectTestDb();
  request = require('supertest');
  app = require('../config/createApp')();
  ({ createPatient, createDietician, createDietPlanRequest, createActiveDietPlan } =
    require('./helpers/factories'));
  ({ MealLog, ManualPaymentProof } = require('../models'));
  NeedAttentionLog = require('../models/NeedAttentionLog');
});

afterEach(async () => {
  clearTestTokens();
  await clearTestDb();
});

afterAll(async () => {
  await disconnectTestDb();
});

const startOfToday = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
};
const noonToday = () => {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  return d;
};
const noonYesterday = () => {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  d.setHours(12, 0, 0, 0);
  return d;
};
const daysFromNow = (n) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d;
};

const approvedProof = (patient, req, amountReceived) =>
  ManualPaymentProof.create({
    patient: patient._id,
    request: req._id,
    status: 'Approved',
    amountReceived,
    amountPending: 0,
  });

describe('GET /api/dietician/dashboard-stats', () => {
  test('rejects an unauthenticated request', async () => {
    const res = await request(app).get('/api/dietician/dashboard-stats');
    expect(res.status).toBe(401);
  });

  test('a dietician with no patients gets all-zero counts and empty lists', async () => {
    const dietician = await createDietician();
    registerTestToken('d', dietician._id);

    const res = await request(app)
      .get('/api/dietician/dashboard-stats')
      .set('Authorization', 'Bearer d');

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual(
      expect.objectContaining({
        messagesReceived: 0,
        messagesReceivedPatients: [],
        reviewLoggedData: 0,
        reviewLoggedPatients: [],
        closingClients: 0,
        closingClientsPatients: [],
        didExtremelyWell: 0,
        didExtremelyWellPatients: [],
        needAttention: 0,
        needAttentionPatients: [],
        needAttentionHistory: [],
        totalRevenue: 0,
      })
    );
  });

  test('reviewLoggedData counts this dietician\'s patients who logged a meal today', async () => {
    const dietician = await createDietician();
    const logged = await createPatient({ profile: { fullName: 'Logged Today' } });
    const notLogged = await createPatient({ profile: { fullName: 'Nope' } });
    await createDietPlanRequest(logged, dietician);
    await createDietPlanRequest(notLogged, dietician);
    await MealLog.create({
      patientId: logged._id,
      date: noonToday(),
      dayKey: `today-${logged._id}`,
      totalCalories: 500,
    });
    registerTestToken('d', dietician._id);

    const res = await request(app)
      .get('/api/dietician/dashboard-stats')
      .set('Authorization', 'Bearer d');

    expect(res.body.data.reviewLoggedData).toBe(1);
    expect(res.body.data.reviewLoggedPatients).toEqual([
      { patientId: logged._id.toString(), patientName: 'Logged Today' },
    ]);
  });

  test('totalRevenue sums only Approved proofs tied to this dietician\'s requests', async () => {
    const dietician = await createDietician();
    const otherDietician = await createDietician();
    const patient = await createPatient();
    const ownReq = await createDietPlanRequest(patient, dietician);
    const otherReq = await createDietPlanRequest(patient, otherDietician);
    await approvedProof(patient, ownReq, 1000);
    await ManualPaymentProof.create({
      patient: patient._id,
      request: ownReq._id,
      status: 'Submitted',
      amountReceived: 999,
      amountPending: 0,
    });
    await approvedProof(patient, otherReq, 5000);
    registerTestToken('d', dietician._id);

    const res = await request(app)
      .get('/api/dietician/dashboard-stats')
      .set('Authorization', 'Bearer d');

    expect(res.body.data.totalRevenue).toBe(1000);
  });

  test('closingClients = active plans ending within the next 7 days', async () => {
    const dietician = await createDietician();
    const soon = await createPatient({ profile: { fullName: 'Ending Soon' } });
    const later = await createPatient({ profile: { fullName: 'Ending Later' } });
    await createDietPlanRequest(soon, dietician);
    await createDietPlanRequest(later, dietician);
    await createActiveDietPlan(soon, dietician, { endDate: daysFromNow(3) });
    await createActiveDietPlan(later, dietician, { endDate: daysFromNow(30) });
    registerTestToken('d', dietician._id);

    const res = await request(app)
      .get('/api/dietician/dashboard-stats')
      .set('Authorization', 'Bearer d');

    expect(res.body.data.closingClients).toBe(1);
    expect(res.body.data.closingClientsPatients).toEqual([
      { patientId: soon._id.toString(), patientName: 'Ending Soon' },
    ]);
  });

  test('an active-plan patient with no meal log yesterday is flagged needAttention', async () => {
    const dietician = await createDietician();
    const patient = await createPatient({ profile: { fullName: 'Silent' } });
    await createDietPlanRequest(patient, dietician);
    await createActiveDietPlan(patient, dietician, { totalCalories: 2000 });
    registerTestToken('d', dietician._id);

    const res = await request(app)
      .get('/api/dietician/dashboard-stats')
      .set('Authorization', 'Bearer d');

    expect(res.body.data.needAttention).toBe(1);
    expect(res.body.data.needAttentionPatients[0]).toEqual({
      patientId: patient._id.toString(),
      patientName: 'Silent',
    });
  });

  test('a patient within 0.8-1.2 of budget yesterday counts as didExtremelyWell', async () => {
    const dietician = await createDietician();
    const patient = await createPatient({ profile: { fullName: 'On Track' } });
    await createDietPlanRequest(patient, dietician);
    await createActiveDietPlan(patient, dietician, { totalCalories: 2000 });
    await MealLog.create({
      patientId: patient._id,
      date: noonYesterday(),
      dayKey: `yday-${patient._id}`,
      totalCalories: 1900,
    });
    registerTestToken('d', dietician._id);

    const res = await request(app)
      .get('/api/dietician/dashboard-stats')
      .set('Authorization', 'Bearer d');

    expect(res.body.data.didExtremelyWell).toBe(1);
    expect(res.body.data.needAttention).toBe(0);
  });

  test('need-attention flags are persisted (fire-and-forget) with acknowledged=false', async () => {
    const dietician = await createDietician();
    const patient = await createPatient();
    await createDietPlanRequest(patient, dietician);
    await createActiveDietPlan(patient, dietician, { totalCalories: 2000 });
    registerTestToken('d', dietician._id);

    await request(app).get('/api/dietician/dashboard-stats').set('Authorization', 'Bearer d');

    // The flag write is fire-and-forget after the response - poll briefly.
    let rows = [];
    for (let i = 0; i < 40 && rows.length === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 25));
      rows = await NeedAttentionLog.find({ dieticianId: dietician._id }).lean();
    }
    expect(rows).toHaveLength(1);
    expect(rows[0].patientId.toString()).toBe(patient._id.toString());
    expect(rows[0].acknowledged).toBe(false);
  });

  test('an acknowledged need-attention patient is reported in history, not as present', async () => {
    const dietician = await createDietician();
    const patient = await createPatient({ profile: { fullName: 'Seen' } });
    await createDietPlanRequest(patient, dietician);
    await createActiveDietPlan(patient, dietician, { totalCalories: 2000 });
    await NeedAttentionLog.create({
      dieticianId: dietician._id,
      patientId: patient._id,
      flagDate: startOfToday(),
      acknowledged: true,
    });
    registerTestToken('d', dietician._id);

    const res = await request(app)
      .get('/api/dietician/dashboard-stats')
      .set('Authorization', 'Bearer d');

    expect(res.body.data.needAttention).toBe(0);
    expect(res.body.data.needAttentionHistory).toEqual([
      expect.objectContaining({ patientId: patient._id.toString(), patientName: 'Seen' }),
    ]);
  });
});

describe('GET /api/dietician/performance-trends', () => {
  test('rejects an unauthenticated request', async () => {
    const res = await request(app).get('/api/dietician/performance-trends');
    expect(res.status).toBe(401);
  });

  test('returns 12 weekly buckets plus cumulative totals for this dietician', async () => {
    const dietician = await createDietician();
    const other = await createDietician();
    const patient = await createPatient();
    const req = await createDietPlanRequest(patient, dietician);
    await approvedProof(patient, req, 1500);
    // Another dietician's request+revenue must not leak in.
    const otherReq = await createDietPlanRequest(patient, other);
    await approvedProof(patient, otherReq, 9999);
    registerTestToken('d', dietician._id);

    const res = await request(app)
      .get('/api/dietician/performance-trends')
      .set('Authorization', 'Bearer d');

    expect(res.status).toBe(200);
    expect(res.body.data.totalPatients).toBe(1);
    expect(res.body.data.totalRevenue).toBe(1500);
    expect(res.body.data.patientWeekly).toHaveLength(12);
    expect(res.body.data.revenueWeekly).toHaveLength(12);
    // current week is the last bucket
    expect(res.body.data.patientWeekly[11]).toBe(1);
    expect(res.body.data.revenueWeekly[11]).toBe(1500);
  });
});
