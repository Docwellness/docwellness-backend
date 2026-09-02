/**
 * Per-patient stats cache - cross-app performance optimization, Phase 2
 * (task 2.6). Covers utils/patientStatsCache directly and its use in
 * GET /api/patient/meal-log/today-stats.
 */

// In-memory Redis stand-in supporting what patientStatsCache + utils/cache use.
const mockStore = new Map();
const mockSets = new Map(); // key -> Set
const mockRedis = {
  async get(k) {
    const e = mockStore.get(k);
    if (!e) return null;
    if (e.expiresAt && Date.now() > e.expiresAt) {
      mockStore.delete(k);
      return null;
    }
    return e.value;
  },
  async set(k, v, mode, s) {
    mockStore.set(k, { value: v, expiresAt: mode === 'EX' ? Date.now() + s * 1000 : null });
    return 'OK';
  },
  async del(...keys) {
    let n = 0;
    for (const k of keys) {
      if (mockStore.delete(k)) n += 1;
      if (mockSets.delete(k)) n += 1;
    }
    return n;
  },
  async smembers(k) {
    return [...(mockSets.get(k) || [])];
  },
  // rate-limit-redis's RedisStore constructor probes the connection via
  // sendCommand -> redis.call during createApp(); the limiter middleware
  // itself is skipped under NODE_ENV=test, so a benign stub is enough.
  async call() {
    return 'OK';
  },
  multi() {
    const ops = [];
    const chain = {
      sadd: (k, v) => {
        ops.push(() => {
          if (!mockSets.has(k)) mockSets.set(k, new Set());
          mockSets.get(k).add(v);
        });
        return chain;
      },
      expire: () => chain,
      async exec() {
        ops.forEach((op) => op());
        return [];
      },
    };
    return chain;
  },
};
jest.mock('../utils/redisClient', () => ({ client: mockRedis, isEnabled: true }));

const { connectTestDb, disconnectTestDb, clearTestDb } = require('./helpers/testDb');

jest.mock('../utils/supabaseAuth');
const { registerTestToken, clearTestTokens } = require('../utils/supabaseAuth');

let request;
let app;
let createPatient;
let createDietician;
let createActiveDietPlan;
let MealLog;
let Progress;
let getOrSetPatientStat;
let invalidatePatientStats;

beforeAll(async () => {
  await connectTestDb();
  request = require('supertest');
  app = require('../config/createApp')();
  ({ createPatient, createDietician, createActiveDietPlan } = require('./helpers/factories'));
  ({ MealLog, Progress } = require('../models'));
  ({ getOrSetPatientStat, invalidatePatientStats } = require('../utils/patientStatsCache'));
});

afterEach(async () => {
  mockStore.clear();
  mockSets.clear();
  clearTestTokens();
  await clearTestDb();
});

afterAll(async () => {
  await disconnectTestDb();
});

describe('utils/patientStatsCache', () => {
  test('getOrSetPatientStat caches, and invalidatePatientStats wipes every window', async () => {
    let calls = 0;
    const fetchFn = async () => {
      calls += 1;
      return { n: calls };
    };

    const a1 = await getOrSetPatientStat('p1', 'pstat:x:p1:a', 60, fetchFn);
    const a2 = await getOrSetPatientStat('p1', 'pstat:x:p1:a', 60, fetchFn);
    const b1 = await getOrSetPatientStat('p1', 'pstat:x:p1:b', 60, fetchFn);
    expect(a1).toEqual({ n: 1 });
    expect(a2).toEqual({ n: 1 }); // served from cache
    expect(b1).toEqual({ n: 2 });

    await invalidatePatientStats('p1');

    const a3 = await getOrSetPatientStat('p1', 'pstat:x:p1:a', 60, fetchFn);
    const b2 = await getOrSetPatientStat('p1', 'pstat:x:p1:b', 60, fetchFn);
    expect(a3).toEqual({ n: 3 }); // recomputed
    expect(b2).toEqual({ n: 4 });
  });

  test("one patient's invalidation does not touch another's cache", async () => {
    const f = (tag) => async () => ({ tag });
    await getOrSetPatientStat('p1', 'pstat:x:p1:a', 60, f('p1'));
    await getOrSetPatientStat('p2', 'pstat:x:p2:a', 60, f('p2'));

    await invalidatePatientStats('p1');

    let p2Recomputed = false;
    await getOrSetPatientStat('p2', 'pstat:x:p2:a', 60, async () => {
      p2Recomputed = true;
      return {};
    });
    expect(p2Recomputed).toBe(false);
  });
});

describe('GET /api/patient/meal-log/today-stats caching', () => {
  // Must match dietController's normalizeDate(new Date()) exactly - the
  // today-stats query is `MealLog.findOne({ patientId, date: today })` with
  // date as an exact-equality match on midnight-UTC today, not a range.
  const utcMidnightToday = () => {
    const d = new Date();
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  };
  const todayKey = () => utcMidnightToday().toISOString().slice(0, 10);

  test('a repeat request is served from cache; a meal-log write + invalidation makes it recompute', async () => {
    const dietician = await createDietician();
    const patient = await createPatient();
    await createActiveDietPlan(patient, dietician); // active, no finalizedPlan -> empty planned meals
    registerTestToken('p', patient._id);

    const first = await request(app)
      .get('/api/patient/meal-log/today-stats')
      .set('Authorization', 'Bearer p');
    expect(first.status).toBe(200);
    expect(first.body.data.summary.totalConsumedCalories).toBe(0);

    // Log a meal directly, bypassing the invalidation-wired handlers.
    await MealLog.create({
      patientId: patient._id,
      date: utcMidnightToday(),
      dayKey: todayKey(),
      meals: [{ mealType: 'Breakfast', servingTime: 'Breakfast', servings: 1, caloriesConsumed: 250 }],
      totalCalories: 250,
    });

    const cached = await request(app)
      .get('/api/patient/meal-log/today-stats')
      .set('Authorization', 'Bearer p');
    expect(cached.body.data.summary.totalConsumedCalories).toBe(0); // still cached

    await invalidatePatientStats(patient._id);

    const fresh = await request(app)
      .get('/api/patient/meal-log/today-stats')
      .set('Authorization', 'Bearer p');
    expect(fresh.body.data.summary.totalConsumedCalories).toBe(250);
  });

  test('a patient with no active plan gets 404 (and it is not cached as a 200)', async () => {
    const patient = await createPatient();
    registerTestToken('p', patient._id);
    const r1 = await request(app)
      .get('/api/patient/meal-log/today-stats')
      .set('Authorization', 'Bearer p');
    const r2 = await request(app)
      .get('/api/patient/meal-log/today-stats')
      .set('Authorization', 'Bearer p');
    expect(r1.status).toBe(404);
    expect(r2.status).toBe(404);
  });
});

describe('GET /api/patient/tracking-data caching', () => {
  test('repeat request is cached; a progress write + invalidation recomputes currentWeight', async () => {
    const dietician = await createDietician();
    const patient = await createPatient();
    await createActiveDietPlan(patient, dietician);
    registerTestToken('p', patient._id);

    const first = await request(app)
      .get('/api/patient/tracking-data')
      .set('Authorization', 'Bearer p');
    expect(first.status).toBe(200);
    const baselineWeight = first.body.data.currentWeight;

    await Progress.create({ patientId: patient._id, date: new Date(), weight: baselineWeight + 12 });

    const cached = await request(app)
      .get('/api/patient/tracking-data')
      .set('Authorization', 'Bearer p');
    expect(cached.body.data.currentWeight).toBe(baselineWeight); // still cached

    await invalidatePatientStats(patient._id);

    const fresh = await request(app)
      .get('/api/patient/tracking-data')
      .set('Authorization', 'Bearer p');
    expect(fresh.body.data.currentWeight).toBe(baselineWeight + 12);
  });
});
