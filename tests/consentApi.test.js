const { connectTestDb, disconnectTestDb, clearTestDb } = require('./helpers/testDb');

jest.mock('../utils/supabaseAuth');
const { registerTestToken, clearTestTokens } = require('../utils/supabaseAuth');

let request;
let app;
let User;
let factories;
let erasePatientCompletely;

beforeAll(async () => {
  await connectTestDb();
  request = require('supertest');
  app = require('../config/createApp')();
  ({ User } = require('../models'));
  factories = require('./helpers/factories');
  ({ erasePatientCompletely } = require('../utils/patientDataDeletion'));
});

afterEach(async () => {
  clearTestTokens();
  await clearTestDb();
});

afterAll(async () => {
  await disconnectTestDb();
});

const authed = (token) => ({ Authorization: `Bearer ${token}` });
const body = (overrides = {}) => ({
  type: 'health_data',
  granted: true,
  policyVersion: '2026-10',
  source: 'settings',
  ...overrides,
});

async function patientWithToken(token) {
  const patient = await factories.createPatient();
  registerTestToken(token, patient._id);
  return patient;
}

describe('POST /api/patient/consent', () => {
  test('grant, withdraw and re-grant build a log; GET returns the latest state', async () => {
    const patient = await patientWithToken('p');

    await request(app).post('/api/patient/consent').set(authed('p')).send(body());
    await request(app).post('/api/patient/consent').set(authed('p')).send(body({ granted: false }));
    const res = await request(app).post('/api/patient/consent').set(authed('p')).send(body());

    expect(res.status).toBe(200);
    expect(res.body.data.healthData.granted).toBe(true);
    expect((await User.findById(patient._id)).consents.map((c) => c.granted)).toEqual([true, false, true]);

    const get = await request(app).get('/api/patient/consent').set(authed('p'));
    expect(get.status).toBe(200);
    expect(get.body.data.healthData).toMatchObject({ granted: true, policyVersion: '2026-10' });
    expect(get.body.data.analytics).toBeNull();
  });

  test('an identical repeat of the latest state is not appended', async () => {
    const patient = await patientWithToken('p');

    await request(app).post('/api/patient/consent').set(authed('p')).send(body());
    await request(app).post('/api/patient/consent').set(authed('p')).send(body());

    expect((await User.findById(patient._id)).consents).toHaveLength(1);
  });

  test('a client timestamp is rejected and an invalid type returns 400', async () => {
    await patientWithToken('p');

    const withAt = await request(app)
      .post('/api/patient/consent')
      .set(authed('p'))
      .send(body({ at: '1999-01-01' }));
    const badType = await request(app)
      .post('/api/patient/consent')
      .set(authed('p'))
      .send(body({ type: 'marketing' }));

    expect(withAt.status).toBe(400);
    expect(badType.status).toBe(400);
  });

  test('a dietician token gets 403 and no token gets 401', async () => {
    const dietician = await factories.createDietician();
    registerTestToken('d', dietician._id);

    const asDietician = await request(app).post('/api/patient/consent').set(authed('d')).send(body());
    const anonymous = await request(app).post('/api/patient/consent').send(body());

    expect(asDietician.status).toBe(403);
    expect(anonymous.status).toBe(401);
  });

  test("patient A's decision does not touch patient B", async () => {
    await patientWithToken('a');
    const patientB = await patientWithToken('b');

    await request(app).post('/api/patient/consent').set(authed('a')).send(body());

    expect((await User.findById(patientB._id)).consents).toHaveLength(0);
    const bState = await request(app).get('/api/patient/consent').set(authed('b'));
    expect(bState.body.data.healthData).toBeNull();
  });

  describe('a lost race on the log', () => {
    const isConsentPush = (update) => Boolean(update && update.$push && update.$push.consents);
    let realUpdateOne;

    beforeEach(() => {
      realUpdateOne = User.updateOne.bind(User);
    });
    afterEach(() => {
      jest.restoreAllMocks();
    });

    test('a rival writing the same decision between our read and our update leaves one entry', async () => {
      const patient = await patientWithToken('p');
      let rivalWrote = false;
      jest.spyOn(User, 'updateOne').mockImplementation(async (filter, update, ...rest) => {
        if (isConsentPush(update) && !rivalWrote) {
          rivalWrote = true;
          // The rival request lands first, so our check-then-append is stale.
          await realUpdateOne({ _id: patient._id }, update);
        }
        return realUpdateOne(filter, update, ...rest);
      });

      const res = await request(app).post('/api/patient/consent').set(authed('p')).send(body());

      expect(rivalWrote).toBe(true);
      expect(res.status).toBe(200);
      expect(res.body.data.healthData.granted).toBe(true);
      expect((await User.findById(patient._id)).consents).toHaveLength(1);
    });

    test('every attempt losing the race returns 409 and appends nothing', async () => {
      const patient = await patientWithToken('p');
      const update = jest.spyOn(User, 'updateOne').mockImplementation(async (filter, change, ...rest) =>
        isConsentPush(change) ? { modifiedCount: 0 } : realUpdateOne(filter, change, ...rest)
      );

      const res = await request(app).post('/api/patient/consent').set(authed('p')).send(body());

      expect(update.mock.calls.filter(([, change]) => isConsentPush(change))).toHaveLength(3);
      expect(res.status).toBe(409);
      expect(res.body.success).toBe(false);
      expect(res.body.data).toBeUndefined();
      expect((await User.findById(patient._id)).consents).toHaveLength(0);
    });
  });

  test('the audit line for a recorded decision carries no consent value', async () => {
    const patient = await patientWithToken('p');
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});

    await request(app).post('/api/patient/consent').set(authed('p')).send(body({ granted: false }));

    const lines = log.mock.calls.map(([line]) => String(line)).filter((line) => line.includes('consent_recorded'));
    log.mockRestore();
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({ event: 'consent_recorded', patientId: String(patient._id), type: 'health_data' });
    expect(lines[0]).not.toContain('granted');
  });

  test('overlapping posts of different types keep every decision', async () => {
    const patient = await patientWithToken('p');

    await Promise.all([
      request(app).post('/api/patient/consent').set(authed('p')).send(body()),
      request(app).post('/api/patient/consent').set(authed('p')).send(body({ type: 'analytics', source: 'reprompt' })),
      request(app).post('/api/patient/consent').set(authed('p')).send(body({ type: 'crash_reporting' })),
    ]);

    const types = (await User.findById(patient._id)).consents.map((c) => c.type).sort();
    expect(types).toEqual(['analytics', 'crash_reporting', 'health_data']);
  });

  // The limiters skip themselves while NODE_ENV is 'test' (rateLimiters.js);
  // the check runs per request, so lift it only inside these tests. Buckets are
  // keyed by patient id, and every test creates fresh patients, so these tests
  // do not count against each other.
  describe('rate limits', () => {
    let original;
    beforeEach(() => {
      original = process.env.NODE_ENV;
      process.env.NODE_ENV = 'development';
    });
    afterEach(() => {
      process.env.NODE_ENV = original;
    });

    const post = (token, overrides) => request(app).post('/api/patient/consent').set(authed(token)).send(body(overrides));

    test('the 31st sync decision is limited with 429 while health consent still works', async () => {
      await patientWithToken('p');

      const statuses = [];
      for (let i = 0; i < 31; i += 1) {
        statuses.push((await post('p', { type: 'analytics', granted: i % 2 === 0, source: 'reprompt' })).status);
      }
      expect(statuses.slice(0, 30).every((s) => s === 200)).toBe(true);
      expect(statuses[30]).toBe(429);

      const withdraw = await post('p', { granted: false });
      const crash = await post('p', { type: 'crash_reporting' });
      const get = await request(app).get('/api/patient/consent').set(authed('p'));
      expect(withdraw.status).toBe(200);
      expect(crash.status).toBe(429);
      expect(get.status).toBe(200);
    });

    test('the health bucket allows 60 decisions and limits the 61st', async () => {
      await patientWithToken('p');

      const statuses = [];
      for (let i = 0; i < 61; i += 1) {
        statuses.push((await post('p', { granted: i % 2 === 0 })).status);
      }

      expect(statuses.slice(0, 60).every((s) => s === 200)).toBe(true);
      expect(statuses[60]).toBe(429);
    });

    test('a second patient is not limited by the first', async () => {
      await patientWithToken('a');
      await patientWithToken('b');
      for (let i = 0; i < 31; i += 1) {
        await post('a', { type: 'analytics', granted: i % 2 === 0, source: 'reprompt' });
      }

      const other = await post('b', { type: 'analytics', source: 'reprompt' });

      expect(other.status).toBe(200);
    });

    test('an invalid body is a 400, not a 429, even when the sync bucket is full', async () => {
      await patientWithToken('p');
      for (let i = 0; i < 31; i += 1) {
        await post('p', { type: 'analytics', granted: i % 2 === 0, source: 'reprompt' });
      }

      const res = await post('p', { type: 'marketing' });

      expect(res.status).toBe(400);
    });
  });

  test('the /api/v1/patient mount behaves the same', async () => {
    await patientWithToken('p');

    const res = await request(app).post('/api/v1/patient/consent').set(authed('p')).send(body());
    const get = await request(app).get('/api/v1/patient/consent').set(authed('p'));

    expect(res.status).toBe(200);
    expect(get.body.data.healthData.granted).toBe(true);
  });

  test('entries are gone after the patient is erased', async () => {
    const patient = await patientWithToken('p');
    await request(app).post('/api/patient/consent').set(authed('p')).send(body());

    await erasePatientCompletely(await User.findById(patient._id));

    expect(await User.findById(patient._id)).toBeNull();
  });
});
