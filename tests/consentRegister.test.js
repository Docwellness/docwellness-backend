jest.mock('../utils/emailService', () => ({
  sendSignupOtp: jest.fn(async () => ({ queued: true })),
  sendPasswordResetOtp: jest.fn(async () => ({ queued: true })),
  sendWelcomeEmail: jest.fn(async () => ({ queued: true })),
}));

const { connectTestDb, disconnectTestDb, clearTestDb } = require('./helpers/testDb');

jest.mock('../utils/supabaseAuth');
const {
  registerTestToken,
  registerTestSupabaseIdentity,
  clearTestTokens,
} = require('../utils/supabaseAuth');

let request;
let app;
let User;
let factories;

beforeAll(async () => {
  await connectTestDb();
  request = require('supertest');
  app = require('../config/createApp')();
  ({ User } = require('../models'));
  factories = require('./helpers/factories');
});

afterEach(async () => {
  clearTestTokens();
  await clearTestDb();
});

afterAll(async () => {
  await disconnectTestDb();
});

const registerBody = (extra = {}) => ({
  profile: {
    fullName: 'Test Patient',
    gender: 'Female',
    dateOfBirth: '01-02-1990',
    whatsappNumber: '9876543210',
  },
  healthProfile: {
    weight: 70,
    height: 165,
    bmi: 25.7,
    weightIndex: 2,
    primaryGoal: 'Weight Loss',
    targetWeight: '65',
    activityLevel: 'Sedentary',
    healthConcerns: ["I don't have any of these"],
  },
  ...extra,
});

function newIdentity(token) {
  registerTestSupabaseIdentity(token, { id: `sb-${token}`, email: `${token}@example.test` });
  return { Authorization: `Bearer ${token}` };
}

describe('POST /api/patient/auth/register consents', () => {
  test('a health_data grant is stored as one signup entry with server time', async () => {
    const before = Date.now();
    const res = await request(app)
      .post('/api/patient/auth/register')
      .set(newIdentity('reg-a'))
      .send(
        registerBody({
          consents: [{ type: 'health_data', granted: true, policyVersion: '2026-10' }],
        })
      );

    expect(res.status).toBe(201);
    const user = await User.findOne({ supabaseUserId: 'sb-reg-a' });
    expect(user.consents).toHaveLength(1);
    expect(user.consents[0]).toMatchObject({
      type: 'health_data',
      granted: true,
      policyVersion: '2026-10',
      source: 'signup',
    });
    expect(user.consents[0].at.getTime()).toBeGreaterThanOrEqual(before);
  });

  test('registering without the field still succeeds and records nothing', async () => {
    const res = await request(app)
      .post('/api/patient/auth/register')
      .set(newIdentity('reg-b'))
      .send(registerBody());

    expect(res.status).toBe(201);
    const user = await User.findOne({ supabaseUserId: 'sb-reg-b' });
    expect(user.consents).toHaveLength(0);
  });

  test('an unknown consent type is rejected with 400 and creates no user', async () => {
    const res = await request(app)
      .post('/api/patient/auth/register')
      .set(newIdentity('reg-c'))
      .send(registerBody({ consents: [{ type: 'analytics', granted: true, policyVersion: '2026-10' }] }));

    expect(res.status).toBe(400);
    expect(await User.countDocuments({ supabaseUserId: 'sb-reg-c' })).toBe(0);
  });
});

describe('GET /api/patient/auth/me consents', () => {
  test('returns the consent summary', async () => {
    const patient = await factories.createPatient({
      consents: [
        { type: 'health_data', granted: true, policyVersion: '2026-10', source: 'signup', at: new Date() },
      ],
    });
    registerTestToken('me-token', patient._id);

    const res = await request(app)
      .get('/api/patient/auth/me')
      .set('Authorization', 'Bearer me-token');

    expect(res.status).toBe(200);
    expect(res.body.data.consents.healthData).toMatchObject({ granted: true, policyVersion: '2026-10' });
    expect(res.body.data.consents.analytics).toBeNull();
  });
});
