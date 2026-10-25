const { connectTestDb, disconnectTestDb, clearTestDb } = require('./helpers/testDb');

jest.mock('../utils/supabaseAuth');
const { registerTestToken, clearTestTokens } = require('../utils/supabaseAuth');

let request, app, createPatient, createDietician, createDietPlanRequest;

beforeAll(async () => {
  await connectTestDb();
  request = require('supertest');
  app = require('../config/createApp')();
  ({ createPatient, createDietician, createDietPlanRequest } = require('./helpers/factories'));
});
afterEach(async () => {
  clearTestTokens();
  await clearTestDb();
});
afterAll(async () => disconnectTestDb());

const DAY_MS = 24 * 60 * 60 * 1000;
const istDayKey = (offsetDays) => new Date(Date.now() + 5.5 * 3600 * 1000 + offsetDays * DAY_MS).toISOString().slice(0, 10);

async function statusFor(requestOverrides) {
  const patient = await createPatient();
  if (requestOverrides) {
    await createDietPlanRequest(patient, await createDietician(), requestOverrides);
  }
  registerTestToken('patient-token', patient._id);
  const res = await request(app)
    .get('/api/patient/diet-plan-requests/status')
    .set('Authorization', 'Bearer patient-token');
  expect(res.status).toBe(200);
  return res.body.data;
}

describe('GET /diet-plan-requests/status planEnd', () => {
  test('an ended plan reports its end day and the last weigh-in date', async () => {
    const data = await statusFor({
      status: 'Paid',
      hasActivePlan: true,
      subscriptionExpiresAt: new Date(`${istDayKey(-2)}T10:00:00.000Z`),
    });
    expect(data.planEnd).toEqual({ endDate: istDayKey(-2), weightLastDate: istDayKey(-1) });
  });

  test('a running plan reports its end day and no weigh-in date', async () => {
    const data = await statusFor({
      status: 'Paid',
      hasActivePlan: true,
      subscriptionExpiresAt: new Date(`${istDayKey(10)}T10:00:00.000Z`),
    });
    expect(data.planEnd).toEqual({ endDate: istDayKey(10), weightLastDate: null });
  });

  test('a request with no expiry reports nulls', async () => {
    const data = await statusFor({ status: 'Unpaid' });
    expect(data.planEnd).toEqual({ endDate: null, weightLastDate: null });
  });

  test('a patient with no request reports nulls', async () => {
    const data = await statusFor();
    expect(data.hasRequest).toBe(false);
    expect(data.planEnd).toEqual({ endDate: null, weightLastDate: null });
  });

  test('the existing fields are unchanged', async () => {
    const data = await statusFor({
      status: 'Paid',
      hasActivePlan: true,
      subscriptionExpiresAt: new Date(`${istDayKey(10)}T10:00:00.000Z`),
    });
    expect(data).toEqual(
      expect.objectContaining({
        hasRequest: true,
        status: 'Paid',
        isEditable: false,
        subscriptionExpiresAt: expect.any(String),
      })
    );
  });
});
