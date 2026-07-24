/**
 * AI_EXECUTION_PLAN.md Phase 8, P8-01 - auth login (token verification +
 * role gating) and patient ownership.
 */

const { connectTestDb, disconnectTestDb, clearTestDb } = require('./helpers/testDb');

jest.mock('../utils/supabaseAuth');
const { registerTestToken, clearTestTokens } = require('../utils/supabaseAuth');

let request;
let app;
let createPatient;
let createDietician;
let createDefaultDietician;
let MealLog;

beforeAll(async () => {
  await connectTestDb();
  request = require('supertest');
  app = require('../config/createApp')();
  ({ createPatient, createDietician, createDefaultDietician } = require('./helpers/factories'));
  ({ MealLog } = require('../models'));
});

afterEach(async () => {
  clearTestTokens();
  await clearTestDb();
});

afterAll(async () => {
  await disconnectTestDb();
});

describe('auth: token verification and role gating', () => {
  test('rejects a request with no Authorization header', async () => {
    const res = await request(app).get('/api/patient/auth/me');
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  test('rejects a request with an unrecognized token', async () => {
    const res = await request(app)
      .get('/api/patient/auth/me')
      .set('Authorization', 'Bearer not-a-real-token');
    expect(res.status).toBe(401);
  });

  test('accepts a valid token and resolves the linked patient', async () => {
    const patient = await createPatient();
    registerTestToken('patient-token', patient._id);

    const res = await request(app)
      .get('/api/patient/auth/me')
      .set('Authorization', 'Bearer patient-token');

    expect(res.status).toBe(200);
    expect(res.body.data._id).toBe(patient._id.toString());
  });

  test('rejects a patient token on a dietician-only route', async () => {
    const patient = await createPatient();
    registerTestToken('patient-token', patient._id);

    const res = await request(app)
      .get('/api/dietician/profile')
      .set('Authorization', 'Bearer patient-token');

    expect(res.status).toBe(403);
  });

  test('rejects a dietician token on a patient-only route', async () => {
    const dietician = await createDietician();
    registerTestToken('dietician-token', dietician._id);

    const res = await request(app)
      .get('/api/patient/profile')
      .set('Authorization', 'Bearer dietician-token');

    expect(res.status).toBe(403);
  });
});

describe('patient ownership: a patient only ever sees their own data', () => {
  test('creating a meal log always scopes it to the authenticated patient, never a body-supplied id', async () => {
    // createMealLog also notifies the patient's dietician over chat
    // (sendMealUpdateToChat), which resolves via config.defaultDieticianId
    // - needs a real seeded user there or that side effect throws.
    await createDefaultDietician();
    const patientA = await createPatient();
    const patientB = await createPatient();
    registerTestToken('token-a', patientA._id);
    registerTestToken('token-b', patientB._id);

    // patientA attempts to spoof patientB's id in the body - the
    // controller derives patientId from req.user._id, never req.body, so
    // this must be ignored.
    const res = await request(app)
      .post('/api/patient/meal-logs')
      .set('Authorization', 'Bearer token-a')
      .send({
        patientId: patientB._id.toString(),
        mealType: 'Breakfast',
        recipeId: null,
        servings: 1,
        caloriesConsumed: 300,
      });

    expect(res.status).toBe(201);

    const logsForA = await MealLog.find({ patientId: patientA._id });
    const logsForB = await MealLog.find({ patientId: patientB._id });
    expect(logsForA.length).toBe(1);
    expect(logsForB.length).toBe(0);

    // patientB's own list endpoint (also scoped via req.user._id) must not
    // include patientA's log.
    const listRes = await request(app)
      .get('/api/patient/meal-logs')
      .set('Authorization', 'Bearer token-b');
    expect(listRes.status).toBe(200);
    expect(listRes.body.data.length).toBe(0);
  });
});
