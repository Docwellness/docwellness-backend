/**
 * "Request your diet plan" nudges for signed-up patients: who is chosen, that
 * the wording rotates, the cadence, and admin control of the wording list.
 */
const { connectTestDb, disconnectTestDb, clearTestDb } = require('./helpers/testDb');

jest.mock('../utils/supabaseAuth');
jest.mock('../middlewares/adminAuth', () => ({
  adminAuth: (req, res, next) => {
    req.admin = { email: 'docwellness.fit@gmail.com', user: { _id: '000000000000000000000009' }, permissions: {} };
    next();
  },
  requirePermission: () => (req, res, next) => next(),
}));
const { clearTestTokens } = require('../utils/supabaseAuth');

let request, app, createPatient;
let User, Notification, DietPlanRequest, NotificationRule;
let runRequestPlanNudgeSweep, getRuleDef;

const DAY = 86400_000;
const T0 = new Date('2026-10-14T12:30:00Z');
const at = (days) => new Date(T0.getTime() + days * DAY);

beforeAll(async () => {
  await connectTestDb();
  request = require('supertest');
  app = require('../config/createApp')();
  ({ createPatient } = require('./helpers/factories'));
  ({ User, Notification, DietPlanRequest } = require('../models'));
  NotificationRule = require('../models/NotificationRule');
  ({ runRequestPlanNudgeSweep } = require('../controllers/internal/requestPlanNudgeController'));
  ({ getRuleDef } = require('../utils/notificationRules'));
});
afterEach(async () => {
  clearTestTokens();
  await clearTestDb();
});
afterAll(async () => {
  await disconnectTestDb();
});

// createdAt is managed by mongoose timestamps, so write it underneath them.
async function signedUp({ daysAgo = 3, name = 'Asha Rao', goal } = {}) {
  const p = await createPatient();
  await User.collection.updateOne(
    { _id: p._id },
    { $set: { createdAt: at(-daysAgo), 'profile.fullName': name, ...(goal ? { 'healthProfile.primaryGoal': goal } : {}) }, $unset: { 'status.subscriptionExpiresAt': '' } }
  );
  return p;
}
// The sweep works from `now`, but rows are stamped by the real clock. Backdate what a run
// created to the simulated time so a multi-day scenario sees a consistent history.
async function run({ now }) {
  const before = (await Notification.find({}).select('_id').lean()).map((n) => n._id);
  const res = await runRequestPlanNudgeSweep({ now });
  await Notification.collection.updateMany({ _id: { $nin: before } }, { $set: { createdAt: now } });
  return res;
}
const nudgesFor = (p) => Notification.find({ userId: p._id, type: 'diet_plan_nudge' }).sort({ createdAt: 1 }).lean();

describe('who gets nudged', () => {
  test('only active, never-subscribed patients with no request, at least a day after signing up', async () => {
    const eligible = await signedUp();
    const tooNew = await signedUp({ daysAgo: 0.5 });
    const requested = await signedUp();
    await DietPlanRequest.collection.insertOne({ patient: requested._id, createdAt: at(-1) });
    const subscribed = await signedUp();
    await User.collection.updateOne({ _id: subscribed._id }, { $set: { 'status.subscriptionExpiresAt': at(10) } });
    const lapsed = await signedUp();
    await User.collection.updateOne({ _id: lapsed._id }, { $set: { 'status.subscriptionExpiresAt': at(-10) } });
    const suspended = await signedUp();
    await User.collection.updateOne({ _id: suspended._id }, { $set: { isActive: false } });

    const res = await run({ now: T0 });

    expect(res.notified).toBe(1);
    expect(await nudgesFor(eligible)).toHaveLength(1);
    for (const p of [tooNew, requested, subscribed, lapsed, suspended]) expect(await nudgesFor(p)).toHaveLength(0);
  });

  test('is a no-op when the rule is switched off', async () => {
    const p = await signedUp();
    await NotificationRule.create({ key: 'request_plan_nudge', enabled: false });

    const res = await run({ now: T0 });

    expect(res.disabled).toBe(true);
    expect(await nudgesFor(p)).toHaveLength(0);
  });
});

describe('wording and cadence', () => {
  test('personalises with first name and goal, never leaving a raw placeholder', async () => {
    const withGoal = await signedUp({ name: 'Asha Rao', goal: 'Weight Loss' });
    const noGoal = await signedUp({ name: '' });
    await NotificationRule.create({
      key: 'request_plan_nudge',
      variants: [{ title: '{name}: {days} days in', message: 'Time to {goal}.' }],
    });

    await run({ now: T0 });

    const [a] = await nudgesFor(withGoal);
    expect(a.title).toBe('Asha: 3 days in');
    expect(a.message).toBe('Time to lose weight.');
    const [b] = await nudgesFor(noGoal);
    expect(b.title).toBe('there: 3 days in');
    expect(b.message).toBe('Time to feel your best.');
  });

  test('rotates through every wording in order, never repeating back to back, then wraps', async () => {
    const p = await signedUp({ daysAgo: 100 });
    const count = getRuleDef('request_plan_nudge').defaults.variants.length;

    // A week apart clears both the early (2 day) and later (weekly) gap.
    for (let i = 0; i < count + 1; i += 1) await run({ now: at(i * 7) });

    const titles = (await nudgesFor(p)).map((n) => n.title);
    expect(titles).toHaveLength(count + 1);
    expect(new Set(titles.slice(0, count)).size).toBe(count);
    titles.slice(1).forEach((t, i) => expect(t).not.toBe(titles[i]));
    expect(titles[count]).toBe(titles[0]);
  });

  test('sends at most once per gap: same-day reruns and next-day runs add nothing', async () => {
    const p = await signedUp();
    await run({ now: T0 });
    await run({ now: T0 });
    await run({ now: at(1) });
    expect(await nudgesFor(p)).toHaveLength(1);

    await run({ now: at(2) });
    expect(await nudgesFor(p)).toHaveLength(2);
  });

  test('settles to weekly after the first six', async () => {
    const p = await signedUp({ daysAgo: 100 });
    for (let i = 0; i < 6; i += 1) await run({ now: at(i * 2) });
    expect(await nudgesFor(p)).toHaveLength(6);

    await run({ now: at(10 + 2) }); // 2 days after the sixth
    await run({ now: at(10 + 6) });
    expect(await nudgesFor(p)).toHaveLength(6);

    await run({ now: at(10 + 7) });
    expect(await nudgesFor(p)).toHaveLength(7);
  });

  test('stops once the person requests a plan', async () => {
    const p = await signedUp();
    await run({ now: T0 });
    await DietPlanRequest.collection.insertOne({ patient: p._id, createdAt: at(1) });
    await run({ now: at(3) });
    expect(await nudgesFor(p)).toHaveLength(1);
  });
});

describe('admin control of the wordings', () => {
  const put = (body) => request(app).put('/api/admin/notification-rules/request_plan_nudge').send(body);

  test('lists the shipped wordings, as a rotating rule for signed-up users', async () => {
    const res = await request(app).get('/api/admin/notification-rules').expect(200);
    const rule = res.body.data.items.find((i) => i.key === 'request_plan_nudge');
    expect(rule).toMatchObject({ rotating: true, editable: true, segments: ['signed_up'], customised: false });
    expect(rule.variants.length).toBeGreaterThanOrEqual(8);
  });

  test('saves a new list, audits it, and restore goes back to the shipped list', async () => {
    const saved = await put({ variants: [{ title: 'Hi {name}', message: 'Request now' }, { title: 'Again', message: 'Still here' }] }).expect(200);
    expect(saved.body.data.variants).toHaveLength(2);
    expect(saved.body.data.customised).toBe(true);

    const reset = await put({ reset: true }).expect(200);
    expect(reset.body.data.variants.length).toBeGreaterThanOrEqual(8);
    expect(reset.body.data.customised).toBe(false);
  });

  test('rejects an empty list, unknown placeholders and overlong text', async () => {
    await put({ variants: [] }).expect(400);
    expect((await put({ variants: [{ title: 'Hi {sender}', message: 'x' }] }).expect(400)).body.message).toMatch(/Wording 1.*\{sender\}/);
    await put({ variants: [{ title: 'ok', message: 'x'.repeat(241) }] }).expect(400);
    expect(await NotificationRule.countDocuments()).toBe(0);
  });

  test('turning it off keeps the wordings', async () => {
    await put({ variants: [{ title: 'A', message: 'B' }] }).expect(200);
    const off = await put({ enabled: false }).expect(200);
    expect(off.body.data).toMatchObject({ enabled: false });
    expect(off.body.data.variants).toEqual([{ title: 'A', message: 'B' }]);
  });
});
