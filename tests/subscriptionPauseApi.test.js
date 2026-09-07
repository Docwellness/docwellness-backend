const { connectTestDb, disconnectTestDb, clearTestDb } = require('./helpers/testDb');

jest.mock('../utils/supabaseAuth');
const { registerTestToken, clearTestTokens } = require('../utils/supabaseAuth');

let request;
let app;
let factories;
let models;

const D = (s) => new Date(`${s}T00:00:00.000Z`);
const authed = (t) => ({ Authorization: `Bearer ${t}` });
const isoDay = (d) => new Date(d).toISOString().slice(0, 10);

beforeAll(async () => {
  await connectTestDb();
  request = require('supertest');
  app = require('../config/createApp')();
  factories = require('./helpers/factories');
  models = require('../models');
});

afterEach(async () => {
  clearTestTokens();
  await clearTestDb();
});

afterAll(async () => {
  await disconnectTestDb();
});

async function seedActivePlan(overrides = {}) {
  const dietician = await factories.createDietician();
  const patient = await factories.createPatient();
  const dpRequest = await factories.createDietPlanRequest(patient, dietician, {
    subscriptionExpiresAt: D('2026-10-01'),
  });
  const plan = await models.DietPlan.create({
    patientId: patient._id,
    dieticianId: dietician._id,
    status: 'Active',
    startDate: D('2026-09-01'),
    request: dpRequest._id,
    weekSchedule: [
      { week: 1, startDate: D('2026-09-01'), endDate: D('2026-09-07') },
      { week: 2, startDate: D('2026-09-08'), endDate: D('2026-09-14') },
    ],
    ...overrides,
  });
  return { dietician, patient, dpRequest, plan };
}

const pausePath = (id) => `/api/dietician/patients/${id}/subscription/pause`;

describe('POST subscription/pause', () => {
  test('schedules a pause and extends the subscription by the pause length', async () => {
    const { dietician, patient, dpRequest } = await seedActivePlan();
    registerTestToken('d', dietician._id);

    const res = await request(app)
      .post(pausePath(patient._id))
      .set(authed('d'))
      .send({ startDate: '2099-09-08', resumeDate: '2099-09-11' });

    expect(res.status).toBe(200);
    expect(isoDay(res.body.data.active.resumeDate)).toBe('2099-09-11');

    const updated = await models.DietPlanRequest.findById(dpRequest._id);
    expect(isoDay(updated.subscriptionExpiresAt)).toBe('2026-10-04'); // +3

    const plan = await models.DietPlan.findOne({ patientId: patient._id });
    expect(plan.pauses).toHaveLength(1);

    // The dietician profile must reflect the pause so the app can switch to
    // "Manage / cancel" instead of trying to schedule another one.
    await models.User.updateOne(
      { _id: patient._id },
      { $set: { 'status.activeDietPlanId': plan._id, 'status.requestStatus': 'Paid' } }
    );
    const profile = await request(app)
      .get(`/api/dietician/patients/${patient._id}/profile`)
      .set(authed('d'));
    expect(profile.status).toBe(200);
    expect(profile.body.data.subscriptionPause.active.resumeDate).toBeTruthy();
    expect(isoDay(profile.body.data.subscriptionPause.active.resumeDate)).toBe('2099-09-11');
  });

  test('rejects a pause that starts in the past', async () => {
    const { dietician, patient } = await seedActivePlan();
    registerTestToken('d', dietician._id);
    const res = await request(app)
      .post(pausePath(patient._id))
      .set(authed('d'))
      .send({ startDate: '2020-01-01', resumeDate: '2020-01-05' });
    expect(res.status).toBe(400);
  });

  test('rejects a second pause while one is scheduled', async () => {
    const { dietician, patient } = await seedActivePlan();
    registerTestToken('d', dietician._id);
    await request(app)
      .post(pausePath(patient._id))
      .set(authed('d'))
      .send({ startDate: '2099-09-08', resumeDate: '2099-09-11' });
    const res = await request(app)
      .post(pausePath(patient._id))
      .set(authed('d'))
      .send({ startDate: '2099-10-08', resumeDate: '2099-10-11' });
    expect(res.status).toBe(409);
  });

  test("403 for a dietician who doesn't own the patient", async () => {
    const { patient } = await seedActivePlan();
    const other = await factories.createDietician();
    registerTestToken('other', other._id);
    const res = await request(app)
      .post(pausePath(patient._id))
      .set(authed('other'))
      .send({ startDate: '2099-09-08', resumeDate: '2099-09-11' });
    expect(res.status).toBe(403);
  });
});

describe('PATCH / DELETE subscription/pause', () => {
  test('changing the resume date re-adjusts the subscription by the delta', async () => {
    const { dietician, patient, dpRequest } = await seedActivePlan();
    registerTestToken('d', dietician._id);
    await request(app)
      .post(pausePath(patient._id))
      .set(authed('d'))
      .send({ startDate: '2099-09-08', resumeDate: '2099-09-11' }); // +3

    const res = await request(app)
      .patch(pausePath(patient._id))
      .set(authed('d'))
      .send({ resumeDate: '2099-09-13' }); // +5, delta +2
    expect(res.status).toBe(200);

    const updated = await models.DietPlanRequest.findById(dpRequest._id);
    expect(isoDay(updated.subscriptionExpiresAt)).toBe('2026-10-06');
  });

  test('cancelling a pause undoes the shift (with an active goal + milestone)', async () => {
    const { dietician, patient, dpRequest } = await seedActivePlan();
    // A goal + a still-future milestone - exercises the Milestone shift path
    // that used to crash on the aggregation-pipeline updateMany.
    const goal = await models.Goal.create({
      patientId: patient._id,
      dieticianId: dietician._id,
      status: 'active',
      title: 'Lose weight',
      targetValue: 64,
      startDate: D('2099-09-01'),
      endDate: D('2099-10-01'),
    });
    await models.Milestone.create({
      goalId: goal._id,
      type: 'weekly',
      title: 'W1',
      date: D('2099-09-15'),
      sortOrder: 0,
    });
    registerTestToken('d', dietician._id);
    await request(app)
      .post(pausePath(patient._id))
      .set(authed('d'))
      .send({ startDate: '2099-09-08', resumeDate: '2099-09-11' }); // +3

    // goal + milestone shifted +3
    expect(isoDay((await models.Goal.findById(goal._id)).endDate)).toBe('2099-10-04');
    expect(isoDay((await models.Milestone.findOne({ goalId: goal._id })).date)).toBe('2099-09-18');

    const res = await request(app).delete(pausePath(patient._id)).set(authed('d'));
    expect(res.status).toBe(200);

    const updated = await models.DietPlanRequest.findById(dpRequest._id);
    expect(isoDay(updated.subscriptionExpiresAt)).toBe('2026-10-01');
    const plan = await models.DietPlan.findOne({ patientId: patient._id });
    expect(plan.pauses).toHaveLength(0);
    // shift undone
    expect(isoDay((await models.Goal.findById(goal._id)).endDate)).toBe('2099-10-01');
    expect(isoDay((await models.Milestone.findOne({ goalId: goal._id })).date)).toBe('2099-09-15');
  });

  test('a pause notifies the patient (in-app Notification)', async () => {
    const { dietician, patient } = await seedActivePlan();
    registerTestToken('d', dietician._id);
    await request(app)
      .post(pausePath(patient._id))
      .set(authed('d'))
      .send({ startDate: '2099-09-08', resumeDate: '2099-09-11' });
    const n = await models.Notification.findOne({ userId: patient._id });
    expect(n).not.toBeNull();
    expect(n.type).toBe('subscription_pause');
  });
});

describe('patient logging is blocked during a pause', () => {
  test('POST /api/patient/meal-log 403s while paused', async () => {
    const { patient, plan } = await seedActivePlan();
    const today = new Date();
    plan.pauses.push({
      startDate: new Date(today.getTime() - 86400000),
      resumeDate: new Date(today.getTime() + 2 * 86400000),
    });
    await plan.save();
    registerTestToken('p', patient._id);

    const res = await request(app)
      .post('/api/patient/meal-log')
      .set(authed('p'))
      .send({ date: isoDay(today), items: [] });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PLAN_PAUSED');
  });

  test('meal logging is not pause-blocked once the pause has passed', async () => {
    const { patient, plan } = await seedActivePlan();
    plan.pauses.push({ startDate: D('2026-01-01'), resumeDate: D('2026-01-04') });
    await plan.save();
    registerTestToken('p', patient._id);

    const res = await request(app)
      .post('/api/patient/meal-log')
      .set(authed('p'))
      .send({ date: isoDay(new Date()), items: [] });

    expect(res.status).not.toBe(403); // may be 400 on empty items - pause gate passed
  });
});
