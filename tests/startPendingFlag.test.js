/**
 * The patient's request detail and order list say whether the plan's start is
 * still pending (the dietician picks it when approving the payment), so the
 * app shows "Not started yet" instead of inferring it from a date.
 */
const { connectTestDb, disconnectTestDb, clearTestDb } = require('./helpers/testDb');
const { pastOrderRow, pastOrderDetailOverrides } = require('../utils/pastOrders');

jest.mock('../utils/supabaseAuth');
const { registerTestToken, clearTestTokens } = require('../utils/supabaseAuth');

let request;
let app;
let createPatient;
let createDietician;
let createDietPlanRequest;
let DietPlan;

beforeAll(async () => {
  await connectTestDb();
  request = require('supertest');
  app = require('../config/createApp')();
  ({ createPatient, createDietician, createDietPlanRequest } = require('./helpers/factories'));
  ({ DietPlan } = require('../models'));
});

afterEach(async () => {
  clearTestTokens();
  await clearTestDb();
});

afterAll(async () => {
  await disconnectTestDb();
});

const get = (path) =>
  request(app).get(`/api/patient/diet-plan-requests${path}`).set('Authorization', 'Bearer patient-token');

const START = new Date('2026-11-19T00:00:00.000Z');
const withDates = {
  startDate: START,
  weekSchedule: [{ week: 1, startDate: START, endDate: new Date('2026-11-25T00:00:00.000Z') }],
};

async function seed(planOverrides) {
  const dietician = await createDietician();
  const patient = await createPatient();
  registerTestToken('patient-token', patient._id);
  const dietPlanRequest = await createDietPlanRequest(patient, dietician, { status: 'PaymentSubmitted' });
  if (planOverrides) {
    await DietPlan.create({
      patientId: patient._id,
      dieticianId: dietician._id,
      request: dietPlanRequest._id,
      status: 'Finalized',
      ...planOverrides,
    });
  }
  return { dietPlanRequest, patient, dietician };
}

describe('startPending on the request status and the order list', () => {
  test.each([
    ['a plan waiting for its start date', { startDatePending: true }, true],
    ['a plan with its dates', withDates, false],
    ['a request with no plan yet', null, false],
  ])('%s', async (_label, planOverrides, expected) => {
    const { dietPlanRequest } = await seed(planOverrides);

    const status = await get('/status');
    expect(status.status).toBe(200);
    expect(status.body.data.startPending).toBe(expected);

    const list = await get('/all');
    expect(list.status).toBe(200);
    expect(list.body.data.find((row) => row.requestId === String(dietPlanRequest._id)).startPending).toBe(expected);
  });
});

describe('startPending during a renewal', () => {
  test('is false while the request is shared with a running Active cycle', async () => {
    const { dietPlanRequest, patient, dietician } = await seed({ startDatePending: true, cycleNumber: 2 });
    await DietPlan.create({
      patientId: patient._id,
      dieticianId: dietician._id,
      request: dietPlanRequest._id,
      status: 'Active',
      cycleNumber: 1,
      ...withDates,
    });

    const status = await get('/status');
    expect(status.body.data.startPending).toBe(false);

    const list = await get('/all');
    expect(list.body.data.find((row) => row.requestId === String(dietPlanRequest._id)).startPending).toBe(false);
  });
});

describe('startPending on one order', () => {
  test('is true for the current order while its plan awaits a start date', async () => {
    const { dietPlanRequest } = await seed({ startDatePending: true, cycleNumber: 2 });

    const res = await get(`/${dietPlanRequest._id}`);

    expect(res.status).toBe(200);
    expect(res.body.data.startPending).toBe(true);
  });

  test('is false for an earlier cycle, whose detail overrides the current order', async () => {
    const { dietPlanRequest } = await seed({ startDatePending: true, cycleNumber: 2 });
    const earlierCycle = { cycleNumber: 1, ...withDates };

    expect(pastOrderRow(dietPlanRequest, earlierCycle).startPending).toBe(false);
    expect(pastOrderDetailOverrides(dietPlanRequest, earlierCycle).startPending).toBe(false);
  });
});
