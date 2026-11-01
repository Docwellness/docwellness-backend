/**
 * Two simultaneous creates for one patient and week must not both be stored
 * (utils/progressWeekLock.js), and a duplicate-key error from the database is
 * answered like the already-logged case.
 */
const { connectTestDb, disconnectTestDb, clearTestDb } = require('./helpers/testDb');
const { createTwoCyclePatient } = require('./helpers/twoCycleFixture');

jest.mock('../utils/supabaseAuth');
const { registerTestToken, clearTestTokens } = require('../utils/supabaseAuth');

let request, app;
let Progress, IdempotencyKey;

beforeAll(async () => {
  await connectTestDb();
  request = require('supertest');
  app = require('../config/createApp')();
  ({ Progress } = require('../models'));
  ({ IdempotencyKey } = require('../chat/models'));
  // The unique key index is what makes the lock atomic.
  await IdempotencyKey.init();
});
afterEach(async () => {
  jest.restoreAllMocks();
  clearTestTokens();
  await clearTestDb();
});
afterAll(async () => disconnectTestDb());

async function setup() {
  const fixture = await createTwoCyclePatient();
  registerTestToken('patient-token', fixture.patient._id);
  return fixture;
}

const create = (body) =>
  request(app).post('/api/patient/progress').set('Authorization', 'Bearer patient-token').send(body);

const lockKey = (patient, week) => `progress-week:${patient._id}:${week}`;
const lockDoc = (patient, week, lockedAt) =>
  IdempotencyKey.create({
    key: lockKey(patient, week),
    userId: patient._id,
    endpoint: '/api/patient/progress',
    method: 'POST',
    status: 'pending',
    lockedAt,
  });

describe('POST /api/patient/progress with a week: concurrent creates', () => {
  test('two simultaneous creates for Week 5 store one entry', async () => {
    await setup();
    const responses = await Promise.all([
      create({ weight: 64, week: 5 }),
      create({ weight: 65, week: 5 }),
    ]);
    expect(responses.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await Progress.countDocuments()).toBe(1);
  });

  test('ten parallel creates give exactly one 201', async () => {
    await setup();
    const responses = await Promise.all(
      Array.from({ length: 10 }, (_, i) => create({ weight: 60 + i, week: 5 }))
    );
    expect(responses.filter((r) => r.status === 201)).toHaveLength(1);
    expect(await Progress.countDocuments()).toBe(1);
  });

  test('a fresh lock held by another request answers 409 inProgress and creates nothing', async () => {
    const { patient } = await setup();
    await lockDoc(patient, 5, new Date());
    const res = await create({ weight: 64, week: 5 });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      success: false,
      message: 'Week 5 is already being saved',
      inProgress: true,
    });
    expect(await Progress.countDocuments()).toBe(0);
  });

  test('a lock two minutes old is taken over', async () => {
    const { patient } = await setup();
    await lockDoc(patient, 5, new Date(Date.now() - 2 * 60 * 1000));
    const res = await create({ weight: 64, week: 5 });
    expect(res.status).toBe(201);
    expect(await IdempotencyKey.countDocuments({ key: lockKey(patient, 5) })).toBe(0);
  });

  test('two patients creating the same week at once both succeed', async () => {
    await setup();
    const other = await createTwoCyclePatient();
    registerTestToken('other-token', other.patient._id);
    const [a, b] = await Promise.all([
      create({ weight: 64, week: 5 }),
      request(app)
        .post('/api/patient/progress')
        .set('Authorization', 'Bearer other-token')
        .send({ weight: 70, week: 5 }),
    ]);
    expect([a.status, b.status]).toEqual([201, 201]);
  });
});

describe('the lock is always released', () => {
  test('after a 201', async () => {
    await setup();
    expect((await create({ weight: 64, week: 5 })).status).toBe(201);
    expect(await IdempotencyKey.countDocuments()).toBe(0);
  });

  test('after a 400 unknown week', async () => {
    await setup();
    expect((await create({ weight: 64, week: 40 })).status).toBe(400);
    expect(await IdempotencyKey.countDocuments()).toBe(0);
  });

  test('after a 409 existing entry', async () => {
    await setup();
    await create({ weight: 64, week: 5 });
    expect((await create({ weight: 65, week: 5 })).status).toBe(409);
    expect(await IdempotencyKey.countDocuments()).toBe(0);
  });

  test('after a failed create (500)', async () => {
    await setup();
    jest.spyOn(Progress, 'create').mockRejectedValueOnce(new Error('x'));
    expect((await create({ weight: 64, week: 5 })).status).toBe(500);
    expect(await IdempotencyKey.countDocuments()).toBe(0);
  });
});

describe('the guard never costs a weight', () => {
  test('a create without a week takes no lock', async () => {
    await setup();
    const spy = jest.spyOn(IdempotencyKey, 'create');
    expect((await create({ weight: 64 })).status).toBe(201);
    expect(spy).not.toHaveBeenCalled();
  });

  test('a lock insert that fails for another reason still ends in 201', async () => {
    await setup();
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(IdempotencyKey, 'create').mockRejectedValueOnce(new Error('db'));
    const res = await create({ weight: 64, week: 5 });
    expect(res.status).toBe(201);
    expect(await Progress.countDocuments()).toBe(1);
  });
});

describe('duplicate-key error from Progress.create', () => {
  test('answers the already-logged 409 without an existing entry', async () => {
    await setup();
    jest
      .spyOn(Progress, 'create')
      .mockRejectedValueOnce(Object.assign(new Error('dup'), { code: 11000 }));
    const res = await create({ weight: 64, week: 5 });
    expect(res.status).toBe(409);
    expect(res.body.message).toBe('Week 5 already has an entry');
    expect(res.body.existingId).toBeUndefined();
  });

  test('carries the existing id when the entry is found', async () => {
    const { patient } = await setup();
    const real = Progress.create.bind(Progress);
    // The rival entry lands between the controller's check and its insert.
    let rival;
    jest.spyOn(Progress, 'create').mockImplementationOnce(async () => {
      rival = await real({ patientId: patient._id, week: 5, weekBasis: 'display', weight: 63 });
      throw Object.assign(new Error('dup'), { code: 11000 });
    });
    const res = await create({ weight: 64, week: 5 });
    expect(res.status).toBe(409);
    expect(res.body.existingId).toBe(String(rival._id));
  });
});

describe('option B index, built only inside the test database', () => {
  test('rejects a second display row but accepts a legacy and a dietician row', async () => {
    const { patient } = await setup();
    await Progress.collection.createIndex(
      { patientId: 1, week: 1 },
      { unique: true, partialFilterExpression: { weekBasis: 'display' } }
    );
    const row = (extra) => ({ patientId: patient._id, week: 5, weight: 60, ...extra });

    await Progress.create(row({ weekBasis: 'display' }));
    await expect(Progress.create(row({ weekBasis: 'display' }))).rejects.toMatchObject({
      code: 11000,
    });
    await expect(Progress.create(row({}))).resolves.toBeDefined();
    await expect(Progress.create(row({ source: 'dietician' }))).resolves.toBeDefined();
  });
});
