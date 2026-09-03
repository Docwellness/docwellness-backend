/**
 * Cron sweep -> push job queue - cross-app performance optimization, Phase 3
 * (task 3.4, enqueue step). The reminder sweeps now hand each recipient's
 * push to utils/jobQueue instead of awaiting N sequential FCM calls inline.
 * Covers: the sweep enqueues a well-formed `push` job (Redis on), and the
 * `push` handler drives sendPushToTokens + dead-token pruning.
 */

const lists = new Map();
const zsets = new Map();
const getList = (k) => {
  if (!lists.has(k)) lists.set(k, []);
  return lists.get(k);
};
const mockRedis = {
  async rpush(k, v) {
    return getList(k).push(v);
  },
  async lpop(k) {
    const a = getList(k);
    return a.length ? a.shift() : null;
  },
  async llen(k) {
    return getList(k).length;
  },
  async zadd(k, score, member) {
    if (!zsets.has(k)) zsets.set(k, new Map());
    zsets.get(k).set(member, Number(score));
    return 1;
  },
  async zcard(k) {
    return zsets.has(k) ? zsets.get(k).size : 0;
  },
  async zrangebyscore() {
    return [];
  },
  async zrem() {
    return 0;
  },
  async ltrim() {
    return 'OK';
  },
};
jest.mock('../utils/redisClient', () => ({ client: mockRedis, isEnabled: true }));

const mockSendPush = jest.fn();
jest.mock('../utils/push', () => ({
  sendPushToTokens: (...a) => mockSendPush(...a),
  isEnabled: () => true,
}));

const { connectTestDb, disconnectTestDb, clearTestDb } = require('./helpers/testDb');

jest.mock('../utils/supabaseAuth');
const { clearTestTokens } = require('../utils/supabaseAuth');

let createPatient;
let createDietician;
let DietPlan;
let User;
let runMealReminderSweep;
let runJob;

const daysFromNow = (n) => new Date(Date.now() + n * 24 * 60 * 60 * 1000);

beforeAll(async () => {
  await connectTestDb();
  ({ createPatient, createDietician } = require('./helpers/factories'));
  ({ DietPlan, User } = require('../models'));
  ({ runMealReminderSweep } = require('../controllers/internal/mealReminderController'));
  ({ runJob } = require('../utils/jobHandlers'));
});

afterEach(async () => {
  lists.clear();
  zsets.clear();
  mockSendPush.mockReset();
  clearTestTokens();
  await clearTestDb();
});

afterAll(async () => {
  await disconnectTestDb();
});

describe('runMealReminderSweep -> push queue', () => {
  test('enqueues one push job per recipient with tokens instead of sending inline', async () => {
    const dietician = await createDietician();
    const withTokens = await createPatient({ deviceTokens: [{ token: 'tok-A', platform: 'android' }, { token: 'tok-B', platform: 'ios' }] });
    const noTokens = await createPatient();

    for (const p of [withTokens, noTokens]) {
      await DietPlan.create({
        patientId: p._id,
        dieticianId: dietician._id,
        status: 'Active',
        startDate: daysFromNow(-10),
        endDate: daysFromNow(20),
        weekSchedule: [{ week: 1, startDate: daysFromNow(-10), endDate: daysFromNow(20) }],
        finalizedPlan: { weeks: [{ week: 1, dailyMeals: [{ servingTime: 'Breakfast' }] }] },
      });
    }

    const result = await runMealReminderSweep({ slot: 'Breakfast' });

    expect(result.notified).toBe(2); // both got the in-app notification
    expect(result.pushQueued).toBe(1); // only the one with tokens got a push job
    expect(mockSendPush).not.toHaveBeenCalled(); // Redis on -> queued, not sent inline

    const pending = getList('jobs:pending');
    expect(pending).toHaveLength(1);
    const job = JSON.parse(pending[0]);
    expect(job.type).toBe('push');
    expect(job.payload.patientId).toBe(withTokens._id.toString());
    expect(job.payload.tokens).toEqual(['tok-A', 'tok-B']);
    expect(job.payload.notification).toMatchObject({
      title: 'Time for Breakfast',
      data: { deepLink: 'docwellness://timeline', servingTime: 'Breakfast' },
    });
  });
});

describe('push job handler', () => {
  test('calls sendPushToTokens and prunes a dead token from the user doc', async () => {
    const patient = await createPatient({ deviceTokens: [{ token: 'live', platform: 'android' }, { token: 'dead', platform: 'android' }] });

    // Simulate FCM reporting one token as unregistered.
    mockSendPush.mockImplementation(async (tokens, notification, onInvalidToken) => {
      onInvalidToken('dead');
    });

    await runJob({
      type: 'push',
      payload: {
        patientId: patient._id.toString(),
        tokens: ['live', 'dead'],
        notification: { title: 't', body: 'b', data: {} },
      },
    });

    expect(mockSendPush).toHaveBeenCalledTimes(1);
    expect(mockSendPush.mock.calls[0][0]).toEqual(['live', 'dead']);

    // give the fire-and-forget updateOne a tick
    await new Promise((r) => setTimeout(r, 20));
    const fresh = await User.findById(patient._id).select('deviceTokens').lean();
    expect(fresh.deviceTokens.map((t) => t.token)).toEqual(['live']);
  });

  test('a missing handler type rejects (so the queue can fail/retry it)', async () => {
    await expect(runJob({ type: 'nonexistent', payload: {} })).rejects.toThrow(/no handler/);
  });
});
