const { connectTestDb, disconnectTestDb, clearTestDb } = require('./helpers/testDb');

jest.mock('../utils/supabaseAuth');
const { registerTestToken, clearTestTokens } = require('../utils/supabaseAuth');

let request, app, createPatient, createDietician, createDietPlanRequest;
let Goal, Progress;

beforeAll(async () => {
  await connectTestDb();
  request = require('supertest');
  app = require('../config/createApp')();
  ({ createPatient, createDietician, createDietPlanRequest } = require('./helpers/factories'));
  ({ Goal, Progress } = require('../models'));
});
afterEach(async () => {
  clearTestTokens();
  await clearTestDb();
});
afterAll(async () => disconnectTestDb());

const DAY_MS = 24 * 60 * 60 * 1000;
const istDayKey = (offsetDays) => new Date(Date.now() + 5.5 * 3600 * 1000 + offsetDays * DAY_MS).toISOString().slice(0, 10);

/**
 * A patient with a loss goal (70 -> 65 kg unless start/target are given). `endOffset` is when the plan ends
 * relative to today (undefined = no expiry on the request); `weight` is the
 * latest logged weigh-in (undefined = none).
 */
async function setup({ endOffset, weight, startValue = 70, targetValue = 65 } = {}) {
  const dietician = await createDietician();
  const patient = await createPatient();
  await createDietPlanRequest(patient, dietician, {
    status: 'Paid',
    hasActivePlan: true,
    subscriptionExpiresAt: endOffset === undefined ? undefined : new Date(`${istDayKey(endOffset)}T10:00:00.000Z`),
  });
  const goal = await Goal.create({
    patientId: patient._id,
    dieticianId: dietician._id,
    title: 'Lose weight',
    startValue,
    currentValue: startValue,
    targetValue,
    startDate: new Date(Date.now() - 30 * DAY_MS),
    endDate: new Date(Date.now() - 2 * DAY_MS),
  });
  if (weight !== undefined) await Progress.create({ patientId: patient._id, date: new Date(), weight });
  registerTestToken('patient-token', patient._id);
  registerTestToken('dietician-token', dietician._id);
  return { patient, dietician, goal };
}

const get = (url, token = 'patient-token') =>
  request(app).get(url).set('Authorization', `Bearer ${token}`);

describe.each([
  ['GET /api/patient/timeline', '/api/patient/timeline?from=-2&to=2'],
  ['GET /api/patient/timeline/summary', '/api/patient/timeline/summary'],
])('%s outcome', (_label, url) => {
  test('a running plan has a null outcome and unchanged stats', async () => {
    await setup({ endOffset: 5, weight: 66 });
    const res = await get(url);
    expect(res.status).toBe(200);
    expect(res.body.data.outcome).toBeNull();
    expect(res.body.data.stats).toEqual(expect.objectContaining({ daysToGo: expect.any(Number), daysElapsed: expect.any(Number), streak: 0 }));
  });

  test('the plan ending today still has a null outcome (end day is loggable)', async () => {
    await setup({ endOffset: 0, weight: 66 });
    const res = await get(url);
    expect(res.body.data.outcome).toBeNull();
  });

  test('an ended plan with the loss goal reached is achieved', async () => {
    await setup({ endOffset: -1, weight: 64.6 });
    const res = await get(url);
    expect(res.body.data.outcome).toEqual({
      state: 'achieved',
      direction: 'loss',
      kgMoved: 5.4,
      kgPending: null,
      adherencePct: null,
    });
  });

  test('an ended plan with the loss goal not reached is pending with the kg left', async () => {
    await setup({ endOffset: -1, weight: 67.3 });
    const res = await get(url);
    expect(res.body.data.outcome).toMatchObject({ state: 'pending', kgMoved: 2.7, kgPending: 2.3 });
  });

  test('an ended plan with no logged weight is the neutral unknown outcome with no kg figure', async () => {
    await setup({ endOffset: -1 });
    const res = await get(url);
    // The 70 kg goal-creation snapshot is not a weigh-in, so no kg figure may come from it.
    expect(res.body.data.outcome).toEqual({
      state: 'unknown',
      direction: null,
      kgMoved: null,
      kgPending: null,
      adherencePct: null,
    });
  });

  test('an ended gain goal not yet reached is pending with the kg left', async () => {
    await setup({ endOffset: -1, weight: 52, startValue: 50, targetValue: 56 });
    const res = await get(url);
    expect(res.body.data.outcome).toMatchObject({ state: 'pending', direction: 'gain', kgMoved: 2, kgPending: 4 });
  });

  test('an ended gain goal at the target is achieved', async () => {
    await setup({ endOffset: -1, weight: 56.2, startValue: 50, targetValue: 56 });
    const res = await get(url);
    expect(res.body.data.outcome).toMatchObject({ state: 'achieved', direction: 'gain', kgMoved: 6.2, kgPending: null });
  });

  test.each([
    ['inside', 60.4, 'achieved'],
    ['outside', 61, 'pending'],
  ])('an ended maintain goal %s the 0.5 kg band is %s', async (_band, weight, state) => {
    await setup({ endOffset: -1, weight, startValue: 60, targetValue: 60 });
    const res = await get(url);
    expect(res.body.data.outcome).toMatchObject({ state, direction: 'maintain', kgMoved: null });
  });

  test('a request with no expiry has a null outcome', async () => {
    await setup({ weight: 64 });
    const res = await get(url);
    expect(res.body.data.outcome).toBeNull();
  });

  test('a patient with no goal gets the unchanged empty payload', async () => {
    const patient = await createPatient();
    registerTestToken('patient-token', patient._id);
    const res = await get(url);
    expect(res.status).toBe(200);
    expect(res.body.data.goal).toBeNull();
    expect(res.body.data).not.toHaveProperty('outcome');
  });
});

test('the dietician timeline response has no outcome key', async () => {
  const { patient } = await setup({ endOffset: -1, weight: 64 });
  const res = await get(`/api/dietician/patients/${patient._id}/timeline?from=-2&to=2`, 'dietician-token');
  expect(res.status).toBe(200);
  expect(res.body.data.goal).not.toBeNull();
  expect(res.body.data).not.toHaveProperty('outcome');
});
