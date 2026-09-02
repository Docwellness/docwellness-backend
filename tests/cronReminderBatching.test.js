/**
 * Cron reminder sweeps - cross-app performance optimization, Phase 2/3
 * (task 3.4, query part). These sweeps used to issue ~3-4 queries per active
 * patient inside a loop (today's log, an idempotency check, device tokens,
 * a per-row save); the rewrite computes the recipient set and then issues
 * one batched `$in` query for each. These tests pin the observable
 * behaviour (who gets notified, idempotency) so the batching is provably a
 * no-op on outcomes.
 */

const { connectTestDb, disconnectTestDb, clearTestDb } = require('./helpers/testDb');

jest.mock('../utils/supabaseAuth');
const { clearTestTokens } = require('../utils/supabaseAuth');

let createPatient;
let createDietician;
let DietPlan;
let DietPlanRequest;
let MealLog;
let WaterLog;
let Notification;
let runMealReminderSweep;
let runWaterReminderSweep;
let runRenewalReminderSweep;

const now = new Date();
const dayKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(
  now.getUTCDate()
).padStart(2, '0')}`;
const daysFromNow = (n) => new Date(Date.now() + n * 24 * 60 * 60 * 1000);

beforeAll(async () => {
  await connectTestDb();
  ({ createPatient, createDietician } = require('./helpers/factories'));
  ({ DietPlan, DietPlanRequest, MealLog, Notification } = require('../models'));
  WaterLog = require('../models/WaterLog');
  ({ runMealReminderSweep } = require('../controllers/internal/mealReminderController'));
  ({ runWaterReminderSweep } = require('../controllers/internal/waterReminderController'));
  ({ runRenewalReminderSweep } = require('../controllers/internal/renewalReminderController'));
});

afterEach(async () => {
  clearTestTokens();
  await clearTestDb();
});

afterAll(async () => {
  await disconnectTestDb();
});

const activePlanWithSlot = (patient, dietician, slot) =>
  DietPlan.create({
    patientId: patient._id,
    dieticianId: dietician._id,
    status: 'Active',
    startDate: daysFromNow(-10),
    endDate: daysFromNow(20),
    weekSchedule: [{ week: 1, startDate: daysFromNow(-10), endDate: daysFromNow(20) }],
    finalizedPlan: { weeks: [{ week: 1, dailyMeals: [{ servingTime: slot }] }] },
  });

describe('runMealReminderSweep', () => {
  test('notifies exactly the active-plan patients who have the slot today and have not logged it', async () => {
    const dietician = await createDietician();
    const unlogged = await createPatient();
    const logged = await createPatient();
    const noPlan = await createPatient();
    void noPlan;

    await activePlanWithSlot(unlogged, dietician, 'Breakfast');
    await activePlanWithSlot(logged, dietician, 'Breakfast');
    await MealLog.create({
      patientId: logged._id,
      date: now,
      dayKey,
      meals: [{ mealType: 'Breakfast', servingTime: 'Breakfast' }],
    });

    const res = await runMealReminderSweep({ slot: 'Breakfast', now });

    expect(res.checked).toBe(2);
    expect(res.notified).toBe(1);
    const notifs = await Notification.find({ type: 'meal_reminder' }).lean();
    expect(notifs).toHaveLength(1);
    expect(notifs[0].userId.toString()).toBe(unlogged._id.toString());
    expect(notifs[0].title).toBe('Time for Breakfast');
  });

  test('is idempotent - a second run the same day notifies nobody again', async () => {
    const dietician = await createDietician();
    const patient = await createPatient();
    await activePlanWithSlot(patient, dietician, 'Lunch');

    const first = await runMealReminderSweep({ slot: 'Lunch', now });
    const second = await runMealReminderSweep({ slot: 'Lunch', now });

    expect(first.notified).toBe(1);
    expect(second.notified).toBe(0);
    expect(await Notification.countDocuments({ type: 'meal_reminder' })).toBe(1);
  });

  test('does not notify for a slot the plan does not include today', async () => {
    const dietician = await createDietician();
    const patient = await createPatient();
    await activePlanWithSlot(patient, dietician, 'Breakfast');

    const res = await runMealReminderSweep({ slot: 'Dinner', now });

    expect(res.notified).toBe(0);
    expect(await Notification.countDocuments({ type: 'meal_reminder' })).toBe(0);
  });
});

describe('runWaterReminderSweep', () => {
  test('notifies only active-plan patients still short of their water goal', async () => {
    const dietician = await createDietician();
    const short = await createPatient();
    const met = await createPatient();
    await DietPlan.create({
      patientId: short._id,
      dieticianId: dietician._id,
      status: 'Active',
      startDate: daysFromNow(-1),
    });
    await DietPlan.create({
      patientId: met._id,
      dieticianId: dietician._id,
      status: 'Active',
      startDate: daysFromNow(-1),
    });
    const dateStr = now.toISOString().split('T')[0];
    await WaterLog.create({ patientId: short._id, date: dateStr, goal: 2500, totalAmount: 500 });
    await WaterLog.create({ patientId: met._id, date: dateStr, goal: 2500, totalAmount: 2600 });

    const res = await runWaterReminderSweep({ checkpoint: '1', now });

    expect(res.checked).toBe(2);
    expect(res.notified).toBe(1);
    const notifs = await Notification.find({ type: 'water_reminder' }).lean();
    expect(notifs).toHaveLength(1);
    expect(notifs[0].userId.toString()).toBe(short._id.toString());
  });

  test('is idempotent within a checkpoint run window', async () => {
    const dietician = await createDietician();
    const patient = await createPatient();
    await DietPlan.create({
      patientId: patient._id,
      dieticianId: dietician._id,
      status: 'Active',
      startDate: daysFromNow(-1),
    });
    await WaterLog.create({
      patientId: patient._id,
      date: now.toISOString().split('T')[0],
      goal: 2500,
      totalAmount: 0,
    });

    await runWaterReminderSweep({ checkpoint: '1', now });
    const second = await runWaterReminderSweep({ checkpoint: '1', now });

    expect(second.notified).toBe(0);
    expect(await Notification.countDocuments({ type: 'water_reminder' })).toBe(1);
  });
});

describe('runRenewalReminderSweep', () => {
  test('notifies requests expiring inside the 3-day window and stamps them', async () => {
    const dietician = await createDietician();
    const soon = await createPatient();
    const later = await createPatient();
    const soonReq = await DietPlanRequest.create({
      patient: soon._id,
      dieticianId: dietician._id,
      startDateForDiet: now,
      hasActivePlan: true,
      subscriptionExpiresAt: daysFromNow(2),
    });
    await DietPlanRequest.create({
      patient: later._id,
      dieticianId: dietician._id,
      startDateForDiet: now,
      hasActivePlan: true,
      subscriptionExpiresAt: daysFromNow(10),
    });

    const res = await runRenewalReminderSweep({ now });

    expect(res.checked).toBe(1);
    expect(res.created).toBe(1);
    const notifs = await Notification.find({ type: 'membership_renewal' }).lean();
    expect(notifs).toHaveLength(1);
    expect(notifs[0].userId.toString()).toBe(soon._id.toString());
    const stamped = await DietPlanRequest.findById(soonReq._id).lean();
    expect(stamped.renewalReminderSentAt).toBeTruthy();
  });

  test('does not re-notify an already-stamped request', async () => {
    const dietician = await createDietician();
    const patient = await createPatient();
    await DietPlanRequest.create({
      patient: patient._id,
      dieticianId: dietician._id,
      startDateForDiet: now,
      hasActivePlan: true,
      subscriptionExpiresAt: daysFromNow(2),
    });

    await runRenewalReminderSweep({ now });
    const second = await runRenewalReminderSweep({ now });

    expect(second.checked).toBe(0);
    expect(second.created).toBe(0);
    expect(await Notification.countDocuments({ type: 'membership_renewal' })).toBe(1);
  });
});
