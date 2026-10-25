const mongoose = require('mongoose');
const { connectTestDb, disconnectTestDb, clearTestDb } = require('./helpers/testDb');

jest.mock('../utils/supabaseAuth');
const { registerTestToken, clearTestTokens } = require('../utils/supabaseAuth');

// Required at load, not in beforeAll: the describe blocks below build date keys while collecting tests.
const planEnd = require('../utils/planEnd');

let request, app, guard;
let createPatient, createDietician, createDietPlanRequest, createActiveDietPlan;
let DietPlanRequest, WaterLog, SupplementLog, Progress, GroceryChecklist, Goal, Milestone;

beforeAll(async () => {
  await connectTestDb();
  request = require('supertest');
  app = require('../config/createApp')();
  guard = require('../middlewares/planEndGuard');
  ({ createPatient, createDietician, createDietPlanRequest, createActiveDietPlan } = require('./helpers/factories'));
  ({ DietPlanRequest, WaterLog, SupplementLog, Progress, GroceryChecklist, Goal, Milestone } = require('../models'));
});
afterEach(async () => {
  clearTestTokens();
  await clearTestDb();
  jest.restoreAllMocks();
});
afterAll(async () => disconnectTestDb());

const DAY_MS = 24 * 60 * 60 * 1000;
// IST calendar day key `offset` days from today.
const dayKey = (offset) => planEnd.istDayKey(new Date(Date.now() + offset * DAY_MS));
// An expiry stamped mid-day IST on the given day key.
const expiryOn = (key) => new Date(`${key}T10:00:00.000Z`);

/** A patient whose plan ends `endOffset` days from today (negative = already ended). */
async function setupPatient({ endOffset, requestOverrides = {} } = {}) {
  const dietician = await createDietician();
  const patient = await createPatient();
  const subscriptionExpiresAt = endOffset === undefined ? undefined : expiryOn(dayKey(endOffset));
  const dietRequest = await createDietPlanRequest(patient, dietician, {
    status: 'Paid',
    hasActivePlan: true,
    subscriptionExpiresAt,
    ...requestOverrides,
  });
  registerTestToken('patient-token', patient._id);
  return { patient, dietician, dietRequest };
}

const call = (method, url, body) => {
  const req = request(app)[method](url).set('Authorization', 'Bearer patient-token');
  return method === 'get' || method === 'delete' ? req : req.send(body);
};

const waterBody = (date) => ({ date, entries: [{ amount: 250, time: '10:00' }] });
const supplementBody = (date) => ({ date, supplementId: 'sup1', servingTime: 'Breakfast' });
const supplementQuery = (date) => `?date=${date}&supplementId=sup1&servingTime=Breakfast`;

describe('middleware with stubbed req/res', () => {
  const stubRes = () => {
    const res = { status: jest.fn(() => res), json: jest.fn(() => res) };
    return res;
  };

  test('requireLoggingOpen refuses a body date after the end day and reports the dates', async () => {
    const { patient } = await setupPatient({ endOffset: -2 });
    const res = stubRes();
    const next = jest.fn();
    await guard.requireLoggingOpen({ user: patient, body: { date: dayKey(-1) }, query: {} }, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        code: 'PLAN_ENDED',
        endDate: dayKey(-2),
        weightLastDate: dayKey(-1),
      })
    );
  });

  test('requireLoggingOpen reads the date from the query when the body has none', async () => {
    const { patient } = await setupPatient({ endOffset: -2 });
    const res = stubRes();
    const next = jest.fn();
    await guard.requireLoggingOpen({ user: patient, body: {}, query: { date: dayKey(-2) } }, res, next);
    expect(next).toHaveBeenCalledWith();
    expect(res.status).not.toHaveBeenCalled();
  });

  test('requireLoggingOpen without a date gates on today in IST', async () => {
    const { patient } = await setupPatient({ endOffset: -1 });
    const res = stubRes();
    const next = jest.fn();
    await guard.requireLoggingOpen({ user: patient, body: {}, query: {} }, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  test('requireWeightWindowOpen lets the weigh-in day through and refuses the day after', async () => {
    const open = await setupPatient({ endOffset: -1 });
    const openNext = jest.fn();
    await guard.requireWeightWindowOpen({ user: open.patient, body: {}, query: {} }, stubRes(), openNext);
    expect(openNext).toHaveBeenCalledWith();

    const { patient } = await setupPatient({ endOffset: -2 });
    const res = stubRes();
    const next = jest.fn();
    await guard.requireWeightWindowOpen({ user: patient, body: {}, query: {} }, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  test('a missing expiry on an active-plan request lets the write through and warns with the request id only', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { patient, dietRequest } = await setupPatient({});
    const next = jest.fn();
    await guard.requireLoggingOpen({ user: patient, body: { date: dayKey(3) }, query: {} }, stubRes(), next);
    expect(next).toHaveBeenCalledWith();
    expect(warn).toHaveBeenCalledTimes(1);
    const line = warn.mock.calls[0].join(' ');
    expect(line).toContain(String(dietRequest._id));
    expect(line).not.toContain(String(patient._id));
  });

  test('a missing expiry warns once per request id, not on every write', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { patient } = await setupPatient({});
    for (let i = 0; i < 3; i += 1) {
      await guard.requireLoggingOpen({ user: patient, body: {}, query: {} }, stubRes(), jest.fn());
    }
    expect(warn).toHaveBeenCalledTimes(1);
  });

  test.each(['requireLoggingOpen', 'requireWeightWindowOpen'])(
    '%s fails open when the plan end lookup throws, warning with the patient id only',
    async (name) => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const { patient } = await setupPatient({ endOffset: -5 });
      jest.spyOn(DietPlanRequest, 'findOne').mockImplementation(() => {
        throw new Error('db down: weight 70.5');
      });
      const res = stubRes();
      const next = jest.fn();
      await guard[name]({ user: patient, body: { date: dayKey(0) }, query: {} }, res, next);
      expect(next).toHaveBeenCalledWith();
      expect(res.status).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledTimes(1);
      const line = warn.mock.calls[0].join(' ');
      expect(line).toContain(String(patient._id));
      expect(line).not.toContain('70.5');
    }
  );

  test('a first-time patient with no plan and no expiry does not warn', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { patient } = await setupPatient({ requestOverrides: { hasActivePlan: false, status: 'Unpaid' } });
    const next = jest.fn();
    await guard.requireLoggingOpen({ user: patient, body: {}, query: {} }, stubRes(), next);
    expect(next).toHaveBeenCalledWith();
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('ended plan: non-weight writes are refused', () => {
  const today = dayKey(0);
  const id = String(new mongoose.Types.ObjectId());
  // Every row has a body slot (undefined for delete) so jest-each never mistakes the test fn's last parameter for a callback.
  const closedWrites = [
    ['post', '/api/patient/meal-log', { date: today }],
    ['post', '/api/patient/meal-log/add-note', { date: today }],
    ['post', '/api/patient/meal-logs', { date: today }],
    ['put', `/api/patient/meal-logs/${id}/meal/0`, {}],
    ['delete', `/api/patient/meal-logs/${id}/meal/0`, undefined],
    ['post', `/api/patient/meal-logs/${id}/meal/0/complete`, {}],
    ['post', '/api/patient/meal-notes', { date: today }],
    ['post', '/api/patient/water/log', waterBody(today)],
    ['post', '/api/patient/supplement-log', supplementBody(today)],
    ['delete', `/api/patient/supplement-log${supplementQuery(today)}`, undefined],
    ['post', '/api/patient/exercise-log', { date: today, exercises: [] }],
    ['post', '/api/patient/check-ins', { taskId: id, milestoneId: id }],
    ['delete', `/api/patient/check-ins/today/${id}`, undefined],
    ['patch', '/api/patient/diet/groceries/checked', { week: 1, items: [{ key: 'oats', purchased: true }] }],
  ];

  test.each(closedWrites)('%s %s answers 403 PLAN_ENDED', async (method, url, body) => {
    await setupPatient({ endOffset: -2 });
    const res = await call(method, url, body);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PLAN_ENDED');
    expect(res.body.endDate).toBe(dayKey(-2));
  });

  describe.each(['/api/patient/meal-log/add-note', '/api/patient/meal-notes'])('multipart %s', (url) => {
    const postForm = (date) =>
      request(app).post(url).set('Authorization', 'Bearer patient-token').field('date', date);

    test('an entry dated on the end day is accepted the next day', async () => {
      await setupPatient({ endOffset: -1 });
      const res = await postForm(dayKey(-1));
      expect(res.body.code).not.toBe('PLAN_ENDED');
    });

    test('an entry dated after the end day is refused', async () => {
      await setupPatient({ endOffset: -2 });
      const res = await postForm(dayKey(-1));
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('PLAN_ENDED');
    });
  });

  test('nothing is stored for a refused water or supplement entry', async () => {
    await setupPatient({ endOffset: -2 });
    await call('post', '/api/patient/water/log', waterBody(dayKey(0)));
    await call('post', '/api/patient/supplement-log', supplementBody(dayKey(0)));
    expect(await WaterLog.countDocuments()).toBe(0);
    expect(await SupplementLog.countDocuments()).toBe(0);
  });

  test('the same refusal comes from the /api/v1/patient mount', async () => {
    await setupPatient({ endOffset: -2 });
    const res = await call('post', '/api/v1/patient/water/log', waterBody(dayKey(0)));
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PLAN_ENDED');
  });

  test('a water entry dated on the end day is still accepted after the end', async () => {
    await setupPatient({ endOffset: -1 });
    const res = await call('post', '/api/patient/water/log', waterBody(dayKey(-1)));
    expect(res.status).toBe(200);
    expect(await WaterLog.countDocuments()).toBe(1);
  });

  test('chat-adjacent actions that are not logging stay open: the water goal still saves', async () => {
    await setupPatient({ endOffset: -2 });
    const res = await call('put', '/api/patient/water/goal', { goal: 3000, date: dayKey(0) });
    expect(res.status).toBe(200);
  });
});

describe('ended plan: weight window', () => {
  test('a weight is accepted on the weigh-in day after the end', async () => {
    await setupPatient({ endOffset: -1 });
    const res = await call('post', '/api/patient/progress', { weight: 70, date: dayKey(0) });
    expect(res.status).toBe(201);
    expect(await Progress.countDocuments()).toBe(1);
  });

  test('a weight is refused once the window has closed, with nothing stored', async () => {
    await setupPatient({ endOffset: -2 });
    const res = await call('post', '/api/patient/progress', { weight: 70, date: dayKey(0) });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PLAN_ENDED');
    expect(res.body.weightLastDate).toBe(dayKey(-1));
    expect(await Progress.countDocuments()).toBe(0);
  });

  test.each([
    ['put', '', {}],
    ['post', '/images', {}],
    ['delete', '', undefined],
  ])('%s on an existing weigh-in%s is refused after the window', async (method, suffix, body) => {
    await setupPatient({ endOffset: -2 });
    const res = await call(method, `/api/patient/progress/${new mongoose.Types.ObjectId()}${suffix}`, body);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PLAN_ENDED');
  });

  test('a weekly milestone after the end sets the last weigh-in date', async () => {
    const { patient, dietician } = await setupPatient({ endOffset: -3 });
    const goal = await Goal.create({
      patientId: patient._id,
      dieticianId: dietician._id,
      title: 'Lose weight',
      startValue: 70,
      targetValue: 65,
      startDate: new Date(Date.now() - 30 * DAY_MS),
      endDate: new Date(Date.now() - 3 * DAY_MS),
    });
    await Milestone.create({
      goalId: goal._id,
      type: 'weekly',
      title: 'Weigh-in',
      date: new Date(`${dayKey(0)}T00:00:00.000Z`),
      sortOrder: 1,
    });
    const res = await call('post', '/api/patient/progress', { weight: 70, date: dayKey(0) });
    expect(res.status).toBe(201);
  });
});

describe('plans that have not ended', () => {
  test('a patient whose expiry is in the future is unaffected', async () => {
    await setupPatient({ endOffset: 5 });
    const res = await call('post', '/api/patient/water/log', waterBody(dayKey(0)));
    expect(res.status).toBe(200);
  });

  test('a patient with no expiry is unaffected and a warning is logged', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await setupPatient({});
    const res = await call('post', '/api/patient/water/log', waterBody(dayKey(0)));
    expect(res.status).toBe(200);
    expect(warn).toHaveBeenCalled();
  });

  test('an Unpaid renewal before the end day keeps logging', async () => {
    await setupPatient({ endOffset: 0, requestOverrides: { status: 'Unpaid' } });
    const res = await call('post', '/api/patient/water/log', waterBody(dayKey(0)));
    expect(res.status).toBe(200);
  });

  test('a paused patient still gets PLAN_PAUSED, not PLAN_ENDED', async () => {
    const { patient, dietician } = await setupPatient({ endOffset: 5 });
    await createActiveDietPlan(patient, dietician, {
      pauses: [
        {
          startDate: new Date(`${dayKey(-1)}T00:00:00.000Z`),
          resumeDate: new Date(`${dayKey(2)}T00:00:00.000Z`),
        },
      ],
    });
    const res = await call('post', '/api/patient/water/log', waterBody(dayKey(0)));
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PLAN_PAUSED');
  });
});

describe('renewal', () => {
  test('an ended patient is refused, then accepted once activation moves the expiry forward', async () => {
    const { dietRequest } = await setupPatient({ endOffset: -2 });
    const refused = await call('post', '/api/patient/water/log', waterBody(dayKey(0)));
    expect(refused.body.code).toBe('PLAN_ENDED');

    await DietPlanRequest.updateOne(
      { _id: dietRequest._id },
      { subscriptionExpiresAt: expiryOn(dayKey(30)) }
    );
    const accepted = await call('post', '/api/patient/water/log', waterBody(dayKey(0)));
    expect(accepted.status).toBe(200);
  });
});

describe('grocery ticks', () => {
  const tick = (purchased) => call('patch', '/api/patient/diet/groceries/checked', {
    week: 1,
    items: [{ key: 'oats', purchased }],
  });

  async function seedTicks(patient) {
    await GroceryChecklist.create({ patientId: patient._id, week: 1, checkedKeys: ['oats', 'rice'] });
  }

  test('tick and untick are refused after the end and stored ticks are unchanged', async () => {
    const { patient } = await setupPatient({ endOffset: -2 });
    await seedTicks(patient);

    for (const purchased of [true, false]) {
      const res = await tick(purchased);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('PLAN_ENDED');
    }
    const stored = await GroceryChecklist.findOne({ patientId: patient._id }).lean();
    expect(stored.checkedKeys).toEqual(['oats', 'rice']);
  });

  test('the checklist stays readable after the end with its previous ticks', async () => {
    const { patient } = await setupPatient({ endOffset: -2 });
    await seedTicks(patient);

    const res = await call('get', '/api/patient/diet/groceries/checked');
    expect(res.status).toBe(200);
    expect(res.body.data.weeks).toEqual([{ week: 1, checkedKeys: ['oats', 'rice'] }]);
    expect((await call('get', '/api/patient/diet/groceries')).status).not.toBe(403);
  });

  test('ticking works on the end day itself', async () => {
    await setupPatient({ endOffset: 0 });
    const res = await tick(true);
    expect(res.status).toBe(200);
    expect(res.body.data.checkedKeys).toContain('oats');
  });
});
