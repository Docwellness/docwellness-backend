/**
 * Deactivated-account access gate (auth-spec-audit follow-up #1).
 * A patient whose User.isActive is false must be rejected on every
 * authenticated route with 403 / code 'account_disabled', not just hidden
 * from the dietician's list.
 */

const { connectTestDb, disconnectTestDb, clearTestDb } = require('./helpers/testDb');

jest.mock('../utils/supabaseAuth');
const { registerTestToken, clearTestTokens } = require('../utils/supabaseAuth');

let request;
let app;
let createPatient;
let createDietician;
let createDietPlanRequest;
let User;

beforeAll(async () => {
  await connectTestDb();
  request = require('supertest');
  app = require('../config/createApp')();
  ({ createPatient, createDietician, createDietPlanRequest } = require('./helpers/factories'));
  ({ User } = require('../models'));
});

afterEach(async () => {
  clearTestTokens();
  await clearTestDb();
});

afterAll(async () => {
  await disconnectTestDb();
});

describe('deactivated account is blocked from authenticated routes', () => {
  test('active patient gets 200, deactivated gets 403 / account_disabled, reactivated gets 200', async () => {
    const patient = await createPatient();
    registerTestToken('p', patient._id);

    const ok = await request(app).get('/api/patient/auth/me').set('Authorization', 'Bearer p');
    expect(ok.status).toBe(200);

    await User.updateOne({ _id: patient._id }, { isActive: false });

    const blocked = await request(app).get('/api/patient/auth/me').set('Authorization', 'Bearer p');
    expect(blocked.status).toBe(403);
    expect(blocked.body).toMatchObject({ success: false, code: 'account_disabled' });

    await User.updateOne({ _id: patient._id }, { isActive: true });

    const back = await request(app).get('/api/patient/auth/me').set('Authorization', 'Bearer p');
    expect(back.status).toBe(200);
  });

  test('an older user with isActive undefined is still allowed', async () => {
    const patient = await createPatient();
    await User.collection.updateOne({ _id: patient._id }, { $unset: { isActive: '' } });
    registerTestToken('p', patient._id);

    const res = await request(app).get('/api/patient/auth/me').set('Authorization', 'Bearer p');
    expect(res.status).toBe(200);
  });

  test('the dietician deactivate action immediately blocks that patient', async () => {
    const dietician = await createDietician();
    const patient = await createPatient();
    await createDietPlanRequest(patient, dietician); // establishes ownership
    registerTestToken('d', dietician._id);
    registerTestToken('p', patient._id);

    const deact = await request(app)
      .put(`/api/dietician/patients/${patient._id}/deactivate`)
      .set('Authorization', 'Bearer d')
      .send({ isActive: false });
    expect(deact.status).toBe(200);

    const blocked = await request(app).get('/api/patient/auth/me').set('Authorization', 'Bearer p');
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('account_disabled');
  });
});
