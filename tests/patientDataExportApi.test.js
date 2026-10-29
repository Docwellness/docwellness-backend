const { connectTestDb, disconnectTestDb, clearTestDb } = require('./helpers/testDb');

jest.mock('../utils/supabaseAuth');
const { registerTestToken, clearTestTokens } = require('../utils/supabaseAuth');

let request;
let app;
let factories;
let models;

beforeAll(async () => {
  await connectTestDb();
  request = require('supertest');
  app = require('../config/createApp')();
  factories = require('./helpers/factories');
  models = require('../models');
});

afterEach(async () => {
  jest.restoreAllMocks();
  clearTestTokens();
  await clearTestDb();
});

afterAll(async () => {
  await disconnectTestDb();
});

const authed = (token) => ({ Authorization: `Bearer ${token}` });

describe('GET /api/patient/data-export', () => {
  test('returns the owner JSON with download and no-store headers', async () => {
    const patient = await factories.createPatient();
    await models.WaterLog.create({ patientId: patient._id, date: '2026-09-01' });
    registerTestToken('p', patient._id);

    const res = await request(app).get('/api/patient/data-export').set(authed('p'));

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="docwellness-data-\d{4}-\d{2}-\d{2}\.json"$/);
    expect(res.body.user.email).toBe(patient.email);
    expect(res.body.categories.waterLog.count).toBe(1);
  });

  test('the /api/v1/patient mount works too', async () => {
    const patient = await factories.createPatient();
    registerTestToken('p', patient._id);

    const res = await request(app).get('/api/v1/patient/data-export').set(authed('p'));

    expect(res.status).toBe(200);
    expect(res.body.version).toBe(1);
  });

  test('a dietician gets 403 and no token gets 401', async () => {
    const dietician = await factories.createDietician();
    registerTestToken('d', dietician._id);

    const asDietician = await request(app).get('/api/patient/data-export').set(authed('d'));
    const anonymous = await request(app).get('/api/patient/data-export');

    expect(asDietician.status).toBe(403);
    expect(anonymous.status).toBe(401);
  });

  test('the fourth request within the hour is limited with 429', async () => {
    const patient = await factories.createPatient();
    registerTestToken('p', patient._id);

    // The limiter skips itself while NODE_ENV is 'test' (rateLimiters.js); the
    // check runs per request, so lift it only for this test.
    const original = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    try {
      const statuses = [];
      for (let i = 0; i < 4; i += 1) {
        const res = await request(app).get('/api/patient/data-export').set(authed('p'));
        statuses.push(res.status);
      }
      expect(statuses).toEqual([200, 200, 200, 429]);
    } finally {
      process.env.NODE_ENV = original;
    }
  });

  test('the audit event carries counts only and no record values', async () => {
    const patient = await factories.createPatient();
    await models.Notification.create({ userId: patient._id, title: 'SecretTitle', message: 'SecretBody' });
    registerTestToken('p', patient._id);
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    const res = await request(app).get('/api/patient/data-export').set(authed('p'));

    expect(res.status).toBe(200);
    const logged = logSpy.mock.calls.map((args) => args.join(' ')).join('\n');
    expect(logged).toContain('patient_data_exported');
    expect(logged).not.toContain('SecretTitle');
    expect(logged).not.toContain('SecretBody');
    expect(logged).not.toContain(patient.email);
  });
});
