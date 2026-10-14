/**
 * Admin-editable automated notifications: the cron sweeps must honour an
 * override (wording, on/off) and fall back to the shipped text otherwise, and
 * the admin API must list every rule, validate edits and write an audit entry.
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

let request, app, createPatient, createDietician;
let DietPlan, Notification, NotificationRule, AdminAuditLog, WaterLog;
let runMealReminderSweep, runWaterReminderSweep;

const now = new Date();
const daysFromNow = (n) => new Date(Date.now() + n * 86400_000);

beforeAll(async () => {
  await connectTestDb();
  request = require('supertest');
  app = require('../config/createApp')();
  ({ createPatient, createDietician } = require('./helpers/factories'));
  ({ DietPlan, Notification } = require('../models'));
  NotificationRule = require('../models/NotificationRule');
  AdminAuditLog = require('../models/AdminAuditLog');
  WaterLog = require('../models/WaterLog');
  ({ runMealReminderSweep } = require('../controllers/internal/mealReminderController'));
  ({ runWaterReminderSweep } = require('../controllers/internal/waterReminderController'));
});
afterEach(async () => {
  clearTestTokens();
  await clearTestDb();
});
afterAll(async () => {
  await disconnectTestDb();
});

async function patientWithBreakfast() {
  const dietician = await createDietician();
  const patient = await createPatient();
  await DietPlan.create({
    patientId: patient._id,
    dieticianId: dietician._id,
    status: 'Active',
    startDate: daysFromNow(-10),
    endDate: daysFromNow(20),
    weekSchedule: [{ week: 1, startDate: daysFromNow(-10), endDate: daysFromNow(20) }],
    finalizedPlan: { weeks: [{ week: 1, dailyMeals: [{ servingTime: 'Breakfast' }] }] },
  });
  return patient;
}

describe('sweeps honour admin overrides', () => {
  test('custom wording is used, with the placeholder filled per recipient', async () => {
    await patientWithBreakfast();
    await NotificationRule.create({ key: 'meal_reminder', title: 'Log {slot} now', message: 'Quick, {slot}!' });

    await runMealReminderSweep({ slot: 'Breakfast', now });

    const [n] = await Notification.find({ type: 'meal_reminder' }).lean();
    expect(n.title).toBe('Log Breakfast now');
    expect(n.message).toBe('Quick, Breakfast!');
  });

  test('a disabled rule sends nothing', async () => {
    await patientWithBreakfast();
    await NotificationRule.create({ key: 'meal_reminder', enabled: false });

    const res = await runMealReminderSweep({ slot: 'Breakfast', now });

    expect(res.disabled).toBe(true);
    expect(await Notification.countDocuments({ type: 'meal_reminder' })).toBe(0);
  });

  test('with no override the shipped wording is used and the rule is on', async () => {
    const dietician = await createDietician();
    const patient = await createPatient();
    await DietPlan.create({ patientId: patient._id, dieticianId: dietician._id, status: 'Active', startDate: daysFromNow(-1) });
    await WaterLog.create({ patientId: patient._id, date: now.toISOString().split('T')[0], goal: 2500, totalAmount: 500 });

    await runWaterReminderSweep({ checkpoint: '1', now });

    const [n] = await Notification.find({ type: 'water_reminder' }).lean();
    expect(n.title).toBe('💧 Sip sip hooray!');
    expect(n.message).toBe("2.0L to go to hit today's water goal. Grab a glass and let's close the gap!");
  });
});

describe('admin notification-rules API', () => {
  test('lists every rule, scheduled first-class and event ones read-only', async () => {
    const res = await request(app).get('/api/admin/notification-rules').expect(200);
    const items = res.body.data.items;
    expect(items.filter((i) => i.editable).map((i) => i.key).sort()).toEqual(
      ['goal_nudge', 'meal_reminder', 'renewal_reminder', 'request_plan_nudge', 'water_reminder']
    );
    expect(items.every((i) => i.stats && typeof i.stats.last30d === 'number')).toBe(true);
    expect(items.find((i) => i.key === 'chat_message').editable).toBe(false);
  });

  test('counts sent notifications per rule', async () => {
    const patient = await createPatient();
    await Notification.create({ userId: patient._id, title: '💧 Sip sip hooray!', message: 'x', type: 'water_reminder' });
    const res = await request(app).get('/api/admin/notification-rules').expect(200);
    expect(res.body.data.items.find((i) => i.key === 'water_reminder').stats.last7d).toBe(1);
  });

  test('counts by type, so reworded or edited titles keep counting and look-alike types stay separate', async () => {
    const patient = await createPatient();
    const mk = (title, type) => Notification.create({ userId: patient._id, title, message: 'x', type });
    await mk('Some reworded renewal title', 'membership_renewal');
    await mk('Asha requested a plan renewal', 'membership_renewal'); // sent to the dietician
    await mk('A reworded goal title', 'milestone');
    await mk('Message from your dietician', 'milestone');

    const { items } = (await request(app).get('/api/admin/notification-rules').expect(200)).body.data;
    const sent = (key) => items.find((i) => i.key === key).stats.last7d;

    expect(sent('renewal_reminder')).toBe(1);
    expect(sent('renewal_requested')).toBe(1);
    expect(sent('goal_nudge')).toBe(1);
    expect(sent('dietician_message')).toBe(1);
  });

  test('tags each rule with the subscription groups it reaches and counts patients per group', async () => {
    const { User } = require('../models');
    const [never, active, ended] = [await createPatient(), await createPatient(), await createPatient()];
    await User.updateOne({ _id: active._id }, { $set: { 'status.subscriptionExpiresAt': daysFromNow(20) } });
    await User.updateOne({ _id: ended._id }, { $set: { 'status.subscriptionExpiresAt': daysFromNow(-5) } });
    void never;

    const { data } = (await request(app).get('/api/admin/notification-rules').expect(200)).body;

    expect(Object.fromEntries(data.segments.map((s) => [s.key, s.patients]))).toEqual({ signed_up: 1, subscribed: 1, lapsed: 1 });
    const segs = (key) => data.items.find((i) => i.key === key).segments;
    expect(segs('meal_reminder')).toEqual(['subscribed']);
    expect(segs('goal_nudge')).toEqual(expect.arrayContaining(['lapsed']));
    expect(segs('consultation_review')).toEqual(['signed_up']);
    expect(segs('meal_logged')).toEqual([]); // addressed to dieticians
  });

  test('saves an edit, audits it, and restore returns to defaults', async () => {
    const put = (body) => request(app).put('/api/admin/notification-rules/water_reminder').send(body);

    const edited = await put({ title: 'Drink up', message: '{remaining}L to go' }).expect(200);
    expect(edited.body.data).toMatchObject({ title: 'Drink up', customised: true });
    expect(await AdminAuditLog.countDocuments({ action: 'notification_rule.update', targetId: 'water_reminder' })).toBe(1);

    const off = await put({ enabled: false }).expect(200);
    expect(off.body.data.enabled).toBe(false);
    expect(off.body.data.title).toBe('Drink up');

    const reset = await put({ reset: true }).expect(200);
    expect(reset.body.data).toMatchObject({ title: '💧 Sip sip hooray!', customised: false, enabled: false });
  });

  test('rejects unknown placeholders, empty text, overlong text and event rules', async () => {
    const put = (key, body) => request(app).put(`/api/admin/notification-rules/${key}`).send(body);
    expect((await put('water_reminder', { title: 'Hi {name}' }).expect(400)).body.message).toMatch(/\{name\}/);
    await put('water_reminder', { message: '  ' }).expect(400);
    await put('water_reminder', { title: 'x'.repeat(66) }).expect(400);
    await put('chat_message', { enabled: false }).expect(400);
    await put('nope', { enabled: false }).expect(404);
    expect(await NotificationRule.countDocuments()).toBe(0);
  });
});
