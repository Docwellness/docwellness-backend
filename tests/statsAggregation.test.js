/**
 * Cross-app performance optimization, Phase 2 (task 2.3):
 *  - GET /api/patient/meal-logs/calorie-trend now sums per day in MongoDB
 *    ($group) instead of pulling every full MealLog doc; the JS loop still
 *    owns the day keys / order / 0-fill.
 *  - GET /api/patient/timeline/summary is served from the per-patient stats
 *    cache (utils/patientStatsCache), invalidated by every write that feeds
 *    Goal-Journey adherence.
 */

// In-memory Redis stand-in - same shape tests/patientStatsCache.test.js uses.
const mockStore = new Map();
const mockSets = new Map();
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
let MealLog;
let Goal;
let Milestone;
let invalidatePatientStats;

// getCalorieTrend buckets by local midnight then labels each bucket with
// that instant's UTC calendar day (`.toISOString().slice(0,10)`), and the
// new $group pipeline keys by the same UTC-day transform - so a fixture
// dated at local midnight lands on exactly one bucket regardless of the
// runner's timezone. (utcMidnight is used where an exact UTC-midnight date
// is what the code under test compares against.)
const localMidnight = (offsetDays = 0) => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + offsetDays);
  return d;
};
const utcMidnight = (offsetDays = 0) => {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d;
};
const ymd = (d) => d.toISOString().slice(0, 10);

beforeAll(async () => {
  await connectTestDb();
  request = require('supertest');
  app = require('../config/createApp')();
  ({ createPatient } = require('./helpers/factories'));
  ({ MealLog, Goal, Milestone } = require('../models'));
  ({ invalidatePatientStats } = require('../utils/patientStatsCache'));
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

describe('GET /api/patient/meal-logs/calorie-trend', () => {
  test('sums each day, 0-fills days with no log, and returns one entry per requested day', async () => {
    const patient = await createPatient();
    registerTestToken('p', patient._id);

    // Two logs on the "today" bucket (must be added together), one 3 days back.
    await MealLog.create({
      patientId: patient._id,
      date: localMidnight(0),
      dayKey: ymd(localMidnight(0)),
      totalCalories: 300,
      meals: [],
    });
    await MealLog.create({
      patientId: patient._id,
      date: localMidnight(0),
      dayKey: ymd(localMidnight(0)),
      totalCalories: 120,
      meals: [],
    });
    await MealLog.create({
      patientId: patient._id,
      date: localMidnight(-3),
      dayKey: ymd(localMidnight(-3)),
      totalCalories: 500,
      meals: [],
    });

    const res = await request(app)
      .get('/api/patient/meal-logs/calorie-trend?days=7')
      .set('Authorization', 'Bearer p');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(7);
    const byDate = Object.fromEntries(res.body.data.map((d) => [d.date, d.calories]));
    expect(byDate[ymd(localMidnight(0))]).toBe(420);
    expect(byDate[ymd(localMidnight(-3))]).toBe(500);
    expect(byDate[ymd(localMidnight(-1))]).toBe(0);
    expect(res.body.data[res.body.data.length - 1].date).toBe(ymd(localMidnight(0)));
    // ascending, contiguous
    const dates = res.body.data.map((d) => d.date);
    expect([...dates].sort()).toEqual(dates);
  });

  test('caps the window at 30 days and ignores another patient\'s logs', async () => {
    const patient = await createPatient();
    const other = await createPatient();
    registerTestToken('p', patient._id);

    await MealLog.create({
      patientId: other._id,
      date: utcMidnight(0),
      dayKey: ymd(utcMidnight(0)),
      totalCalories: 999,
      meals: [],
    });

    const res = await request(app)
      .get('/api/patient/meal-logs/calorie-trend?days=90')
      .set('Authorization', 'Bearer p');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(30);
    expect(res.body.data.every((d) => d.calories === 0)).toBe(true);
  });
});

describe('GET /api/patient/timeline/summary caching', () => {
  async function seedGoal(patient) {
    return Goal.create({
      patientId: patient._id,
      title: 'Lose weight',
      targetValue: 64,
      startDate: utcMidnight(-10),
      endDate: utcMidnight(20),
      status: 'active',
    });
  }

  test('repeat request is cached; an adherence-feeding write + invalidation recomputes', async () => {
    const patient = await createPatient();
    const goal = await seedGoal(patient);
    registerTestToken('p', patient._id);

    const first = await request(app)
      .get('/api/patient/timeline/summary')
      .set('Authorization', 'Bearer p');
    expect(first.status).toBe(200);
    expect(first.body.data.stats.weekTotal).toBe(0);

    // Add a daily milestone in the trailing-week window, bypassing the
    // invalidation-wired write paths.
    await Milestone.create({
      goalId: goal._id,
      type: 'daily',
      title: 'Day 1',
      date: utcMidnight(0),
      sortOrder: 1,
    });

    const cached = await request(app)
      .get('/api/patient/timeline/summary')
      .set('Authorization', 'Bearer p');
    expect(cached.body.data.stats.weekTotal).toBe(0); // still cached

    await invalidatePatientStats(patient._id);

    const fresh = await request(app)
      .get('/api/patient/timeline/summary')
      .set('Authorization', 'Bearer p');
    expect(fresh.body.data.stats.weekTotal).toBe(1);
  });

  test('a check-in write invalidates the cached summary', async () => {
    const patient = await createPatient();
    await seedGoal(patient);
    registerTestToken('p', patient._id);

    await request(app).get('/api/patient/timeline/summary').set('Authorization', 'Bearer p');
    // The per-patient key index should now hold the summary key.
    const idxKey = `pstat:idx:${patient._id}`;
    expect(await mockRedis.smembers(idxKey)).toContain(`pstat:timelinesummary:${patient._id}`);

    // DELETE /check-ins/today/:taskId always 200s (deleteOne is a no-op when
    // nothing matches) and calls invalidatePatientStats.
    const res = await request(app)
      .delete('/api/patient/check-ins/today/000000000000000000000000')
      .set('Authorization', 'Bearer p');
    expect(res.status).toBe(200);
    expect(await mockRedis.smembers(idxKey)).toHaveLength(0);
  });
});
