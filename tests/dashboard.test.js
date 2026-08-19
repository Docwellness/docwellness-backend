/**
 * AI_EXECUTION_PLAN.md Phase 8, P8-01 - patient dashboard (the /api/v1
 * aggregation endpoint added in Phase 5) and dietician patient access.
 */

const { connectTestDb, disconnectTestDb, clearTestDb } = require('./helpers/testDb');

jest.mock('../utils/supabaseAuth');
const { registerTestToken, clearTestTokens } = require('../utils/supabaseAuth');

let request;
let app;
let createPatient;
let createDietician;
let createDietPlanRequest;

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

afterAll(async () => {
  await disconnectTestDb();
});

describe('GET /api/v1/patient/dashboard', () => {
  test('rejects unauthenticated requests', async () => {
    const res = await request(app).get('/api/v1/patient/dashboard');
    expect(res.status).toBe(401);
  });

  test('aggregates profile, request status, and today summary for the authenticated patient', async () => {
    const dietician = await createDietician();
    const patient = await createPatient({
      profile: { fullName: 'Dashboard Patient' },
    });
    await createDietPlanRequest(patient, dietician, { status: 'Paid' });
    registerTestToken('patient-token', patient._id);

    const res = await request(app)
      .get('/api/v1/patient/dashboard')
      .set('Authorization', 'Bearer patient-token');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.profile.fullName).toBe('Dashboard Patient');
    expect(res.body.data.requestStatus.status).toBe('Paid');
    expect(res.body.data.todayMealSummary).toEqual(
      expect.objectContaining({ caloriesConsumed: 0, mealsLogged: 0 })
    );
    // No DEFAULT_DIETICIAN_ID configured in this test env - doctor/
    // unreadChatCount should degrade gracefully, not throw.
    expect(res.body.data.doctor).toBeNull();
    expect(res.body.data.unreadChatCount).toBe(0);
  });

  test('legacy /api/patient/profile still works unchanged (backward compatibility)', async () => {
    const patient = await createPatient();
    registerTestToken('patient-token', patient._id);

    const res = await request(app)
      .get('/api/patient/profile')
      .set('Authorization', 'Bearer patient-token');

    expect(res.status).toBe(200);
  });
});

describe('dietician patient access', () => {
  test('a dietician can fetch a patient profile they have a diet plan request for', async () => {
    const dietician = await createDietician();
    const patient = await createPatient({
      profile: { fullName: 'Accessible Patient' },
    });
    await createDietPlanRequest(patient, dietician);
    registerTestToken('dietician-token', dietician._id);

    const res = await request(app)
      .get(`/api/dietician/patients/${patient._id}/profile`)
      .set('Authorization', 'Bearer dietician-token');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.basic.fullName).toBe('Accessible Patient');
  });

  test('a patient-role token cannot access the dietician patient-profile route', async () => {
    const otherPatient = await createPatient();
    const target = await createPatient();
    registerTestToken('patient-token', otherPatient._id);

    const res = await request(app)
      .get(`/api/dietician/patients/${target._id}/profile`)
      .set('Authorization', 'Bearer patient-token');

    expect(res.status).toBe(403);
  });

  // AI_EXECUTION_PLAN.md Phase 2, P2-05 - a dietician with no DietPlanRequest
  // relationship to a patient must be denied, not just any authenticated
  // dietician. Covers all three endpoints assertDieticianOwnsPatient guards
  // (see controllers/dietician/patientController.js).
  test('a dietician with no diet plan request for a patient is denied on profile/deactivate/delete', async () => {
    const unrelatedDietician = await createDietician();
    const patient = await createPatient({
      profile: { fullName: 'Unassigned Patient' },
    });
    registerTestToken('dietician-token', unrelatedDietician._id);

    const profileRes = await request(app)
      .get(`/api/dietician/patients/${patient._id}/profile`)
      .set('Authorization', 'Bearer dietician-token');
    expect(profileRes.status).toBe(403);

    const deactivateRes = await request(app)
      .put(`/api/dietician/patients/${patient._id}/deactivate`)
      .set('Authorization', 'Bearer dietician-token')
      .send({ isActive: false });
    expect(deactivateRes.status).toBe(403);

    const deleteRes = await request(app)
      .delete(`/api/dietician/patients/${patient._id}`)
      .set('Authorization', 'Bearer dietician-token')
      .send({ confirmEmail: patient.email });
    expect(deleteRes.status).toBe(403);
  });
});
