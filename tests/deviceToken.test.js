const { connectTestDb, disconnectTestDb, clearTestDb } = require('./helpers/testDb');

jest.mock('../utils/supabaseAuth');
const { registerTestToken, clearTestTokens } = require('../utils/supabaseAuth');

let request, app;
let createPatient, createDietician;
let User;

beforeAll(async () => {
  await connectTestDb();
  request = require('supertest');
  app = require('../config/createApp')();
  ({ createPatient, createDietician } = require('./helpers/factories'));
  ({ User } = require('../models'));
});

afterEach(async () => {
  clearTestTokens();
  await clearTestDb();
});

afterAll(async () => {
  await disconnectTestDb();
});

describe('POST /api/patient/device-token', () => {
  test('401s without a token', async () => {
    const res = await request(app).post('/api/patient/device-token').send({ token: 'x', platform: 'android' });
    expect(res.status).toBe(401);
  });

  test('400s without a valid platform', async () => {
    const patient = await createPatient();
    registerTestToken('patient-token', patient._id);

    const res = await request(app)
      .post('/api/patient/device-token')
      .set('Authorization', 'Bearer patient-token')
      .send({ token: 'fcm-token-1', platform: 'windows' });

    expect(res.status).toBe(400);
  });

  test('registers a new device token', async () => {
    const patient = await createPatient();
    registerTestToken('patient-token', patient._id);

    const res = await request(app)
      .post('/api/patient/device-token')
      .set('Authorization', 'Bearer patient-token')
      .send({ token: 'fcm-token-1', platform: 'android' });

    expect(res.status).toBe(200);
    const updated = await User.findById(patient._id);
    expect(updated.deviceTokens).toHaveLength(1);
    expect(updated.deviceTokens[0].token).toBe('fcm-token-1');
    expect(updated.deviceTokens[0].platform).toBe('android');
  });

  test('updates platform/timestamp instead of duplicating an existing token', async () => {
    const patient = await createPatient();
    registerTestToken('patient-token', patient._id);

    await request(app)
      .post('/api/patient/device-token')
      .set('Authorization', 'Bearer patient-token')
      .send({ token: 'fcm-token-1', platform: 'android' });

    await request(app)
      .post('/api/patient/device-token')
      .set('Authorization', 'Bearer patient-token')
      .send({ token: 'fcm-token-1', platform: 'ios' });

    const updated = await User.findById(patient._id);
    expect(updated.deviceTokens).toHaveLength(1);
    expect(updated.deviceTokens[0].platform).toBe('ios');
  });
});

describe('POST /api/dietician/device-token', () => {
  test('registers a device token for a dietician too', async () => {
    const dietician = await createDietician();
    registerTestToken('dietician-token', dietician._id);

    const res = await request(app)
      .post('/api/dietician/device-token')
      .set('Authorization', 'Bearer dietician-token')
      .send({ token: 'fcm-token-2', platform: 'ios' });

    expect(res.status).toBe(200);
    const updated = await User.findById(dietician._id);
    expect(updated.deviceTokens).toHaveLength(1);
  });
});
