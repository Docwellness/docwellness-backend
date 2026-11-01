/**
 * A weekly checkpoint reads and writes only its own week's body-log entry.
 * Week numbers are the canonical display weeks (utils/checkpointWeeks.js):
 * Weeks 1-4 are cycle 1, the first checkpoint of cycle 2 (today in the
 * fixture) is Week 5. Entries saved before this change carry the per-cycle
 * number and no weekBasis; they are translated on read.
 */
const { connectTestDb, disconnectTestDb, clearTestDb } = require('./helpers/testDb');
const { createTwoCyclePatient, utcDay, dayKey } = require('./helpers/twoCycleFixture');

jest.mock('../utils/supabaseAuth');
const { registerTestToken, clearTestTokens } = require('../utils/supabaseAuth');

let request, app;
let Progress, Milestone, DietPlan;

beforeAll(async () => {
  await connectTestDb();
  request = require('supertest');
  app = require('../config/createApp')();
  ({ Progress, Milestone, DietPlan } = require('../models'));
});
afterEach(async () => {
  clearTestTokens();
  await clearTestDb();
});
afterAll(async () => disconnectTestDb());

async function setup() {
  const fixture = await createTwoCyclePatient();
  registerTestToken('patient-token', fixture.patient._id);
  return fixture;
}

const call = (method, url, body) => {
  const req = request(app)[method](url).set('Authorization', 'Bearer patient-token');
  return method === 'get' ? req : req.send(body);
};

// An entry as saved before this change: per-cycle week number, no weekBasis.
const legacyEntry = (patient, week, date, weight) =>
  Progress.create({ patientId: patient._id, week, date, weight });

describe('POST /api/patient/progress with a week', () => {
  test('creates the Week 5 entry with the canonical number and weekBasis display', async () => {
    await setup();
    const res = await call('post', '/api/patient/progress', { weight: 64, week: 5 });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ week: 5, weekBasis: 'display', weight: 64 });
  });

  test('a second create for the same week answers 409 with the existing id and changes nothing', async () => {
    await setup();
    const first = await call('post', '/api/patient/progress', { weight: 64, week: 5 });
    const second = await call('post', '/api/patient/progress', { weight: 99, week: 5 });

    expect(second.status).toBe(409);
    expect(second.body.existingId).toBe(first.body.data._id);
    expect(await Progress.countDocuments()).toBe(1);
    expect((await Progress.findById(first.body.data._id)).weight).toBe(64);
  });

  test('a create for a week that already has a legacy entry is refused too', async () => {
    const { patient } = await setup();
    // Cycle 2's first entry, saved under the old per-cycle number 1.
    const legacy = await legacyEntry(patient, 1, utcDay(-2), 70);
    const res = await call('post', '/api/patient/progress', { weight: 68, week: 5 });
    expect(res.status).toBe(409);
    expect(res.body.existingId).toBe(String(legacy._id));
  });

  test('an unknown week answers 400 and stores nothing', async () => {
    await setup();
    const res = await call('post', '/api/patient/progress', { weight: 64, week: 40 });
    expect(res.status).toBe(400);
    expect(await Progress.countDocuments()).toBe(0);
  });

  test('an entry without a week is created as before', async () => {
    await setup();
    const res = await call('post', '/api/patient/progress', { weight: 64 });
    expect(res.status).toBe(201);
    expect(res.body.data.week).toBeNull();
    expect(res.body.data.weekBasis).toBeUndefined();
  });

  test('a patient whose logging window has closed still gets the existing refusal', async () => {
    const { plan2 } = await setup();
    const start = utcDay(-60);
    await DietPlan.updateOne(
      { _id: plan2._id },
      { weekSchedule: [{ week: 1, startDate: start, endDate: utcDay(-30) }] }
    );
    const res = await call('post', '/api/patient/progress', { weight: 64, week: 5 });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PLAN_ENDED');
    expect(await Progress.countDocuments()).toBe(0);
  });
});

describe('GET /api/patient/progress?week=', () => {
  test('Week 5 is empty while only the cycle 1 Week 1 entry exists', async () => {
    const { patient } = await setup();
    await legacyEntry(patient, 1, utcDay(-33), 72);

    const week5 = await call('get', '/api/patient/progress?week=5&limit=1');
    expect(week5.status).toBe(200);
    expect(week5.body.data).toEqual([]);

    const week1 = await call('get', '/api/patient/progress?week=1&limit=1');
    expect(week1.body.data).toHaveLength(1);
    expect(week1.body.data[0]).toMatchObject({ weight: 72, displayWeek: 1 });
  });

  test('two entries both numbered 1 split between Week 1 and Week 5', async () => {
    const { patient } = await setup();
    await legacyEntry(patient, 1, utcDay(-33), 72);
    await legacyEntry(patient, 1, utcDay(-2), 70);

    const week1 = await call('get', '/api/patient/progress?week=1');
    const week5 = await call('get', '/api/patient/progress?week=5');
    expect(week1.body.data.map((e) => e.weight)).toEqual([72]);
    expect(week5.body.data.map((e) => e.weight)).toEqual([70]);
    expect(week5.body.data[0].displayWeek).toBe(5);
  });

  test('an old number 2 saved inside cycle 2 is Week 6, not Week 2', async () => {
    const { patient } = await setup();
    await legacyEntry(patient, 2, utcDay(0), 69);
    expect((await call('get', '/api/patient/progress?week=6')).body.data).toHaveLength(1);
    expect((await call('get', '/api/patient/progress?week=2')).body.data).toEqual([]);
  });

  test('only the newest entry of a week is returned', async () => {
    const { patient } = await setup();
    await legacyEntry(patient, 1, utcDay(-33), 72);
    await legacyEntry(patient, 1, utcDay(-30), 71);
    const res = await call('get', '/api/patient/progress?week=1');
    expect(res.body.data.map((e) => e.weight)).toEqual([71]);
  });

  test('a non-numeric week answers 400', async () => {
    await setup();
    const res = await call('get', '/api/patient/progress?week=abc');
    expect(res.status).toBe(400);
  });

  test('without a week the list keeps its shape and gains displayWeek', async () => {
    const { patient } = await setup();
    await legacyEntry(patient, 1, utcDay(-2), 70);
    const res = await call('get', '/api/patient/progress');
    expect(res.status).toBe(200);
    expect(res.body.data[0].displayWeek).toBe(5);
    expect(res.body.pagination).toEqual({ total: 1, page: 1, pages: 1, hasMore: false });
  });
});

describe('PUT /api/patient/progress/:id', () => {
  test('never changes the week, weekBasis or date', async () => {
    await setup();
    const created = await call('post', '/api/patient/progress', { weight: 64, week: 5 });
    const id = created.body.data._id;

    const res = await call('put', `/api/patient/progress/${id}`, {
      weight: 63,
      week: 9,
      weekBasis: 'other',
      date: '2020-01-01',
    });
    expect(res.status).toBe(200);

    const stored = await Progress.findById(id).lean();
    expect(stored.weight).toBe(63);
    expect(stored.week).toBe(5);
    expect(stored.weekBasis).toBe('display');
    expect(stored.date).toEqual(new Date(created.body.data.date));
  });
});

describe('GET /api/patient/timeline weekly checkpoint', () => {
  const weeklyToday = async () => {
    const res = await call('get', '/api/patient/timeline?from=-10&to=30');
    expect(res.status).toBe(200);
    return res.body.data.milestones.find(
      (m) => m.type === 'weekly' && m.date.startsWith(dayKey(utcDay(0)))
    );
  };

  test('labels the 1st cycle 2 node Week 5 whatever its stored title says', async () => {
    const { goal } = await setup();
    await Milestone.updateOne(
      { goalId: goal._id, type: 'weekly', date: utcDay(0) },
      { title: 'Week 6' }
    );
    const node = await weeklyToday();
    expect(node.title).toBe('Week 5');
    expect(node.weekNumber).toBe(5);
  });

  test('is not completed while only Week 1 is logged, completed after a Week 5 entry', async () => {
    const { patient } = await setup();
    await legacyEntry(patient, 1, utcDay(-33), 72);
    expect((await weeklyToday()).status).not.toBe('completed');

    const created = await call('post', '/api/patient/progress', { weight: 64, week: 5 });
    expect(created.status).toBe(201);
    expect((await weeklyToday()).status).toBe('completed');
  });

  test('a legacy entry numbered 1 saved inside cycle 2 completes Week 5', async () => {
    const { patient } = await setup();
    await legacyEntry(patient, 1, utcDay(-2), 70);
    expect((await weeklyToday()).status).toBe('completed');
  });
});
