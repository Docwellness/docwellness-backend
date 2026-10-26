/**
 * Meal reminders must also reach patients on v4.0 plan-item plans. Those keep
 * their meals in DayPlan/MealSlotPlan/PlanItem, not finalizedPlan.weeks, so
 * the sweep used to see them as having no meals and never notified them
 * (only the water reminder, which ignores plan contents, got through).
 */
const mongoose = require('mongoose');
const { connectTestDb, disconnectTestDb, clearTestDb } = require('./helpers/testDb');

jest.mock('../utils/supabaseAuth');
const { clearTestTokens } = require('../utils/supabaseAuth');

let createPatient;
let createDietician;
let DietPlan;
let DayPlan;
let MealSlotPlan;
let PlanItem;
let MealLog;
let Notification;
let runMealReminderSweep;
let resolveDayGroupForDate;

const now = new Date();
const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
const dayKey = `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, '0')}-${String(
  today.getUTCDate()
).padStart(2, '0')}`;
const daysFromNow = (n) => new Date(Date.now() + n * 24 * 60 * 60 * 1000);

beforeAll(async () => {
  await connectTestDb();
  ({ createPatient, createDietician } = require('./helpers/factories'));
  ({ DietPlan, DayPlan, MealSlotPlan, PlanItem, MealLog, Notification } = require('../models'));
  ({ runMealReminderSweep } = require('../controllers/internal/mealReminderController'));
  ({ resolveDayGroupForDate } = require('../utils/dayGroups'));
});

afterEach(async () => {
  clearTestTokens();
  await clearTestDb();
});

afterAll(async () => {
  await disconnectTestDb();
});

const todayGroup = () => resolveDayGroupForDate(today);
const otherGroup = () => (todayGroup() === 'Monday' ? 'Tuesday' : 'Monday');

const basePlan = (patient, dietician, extra = {}) => ({
  patientId: patient._id,
  dieticianId: dietician._id,
  status: 'Active',
  startDate: daysFromNow(-10),
  endDate: daysFromNow(20),
  weekSchedule: [{ week: 1, startDate: daysFromNow(-10), endDate: daysFromNow(20) }],
  ...extra,
});

// A plan-item plan with `slot` on `dayGroup` of week 1; `withItem: false`
// leaves the slot empty (no PlanItem).
async function planItemPlan(patient, dietician, { slot, dayGroup, withItem = true }) {
  const plan = await DietPlan.create(basePlan(patient, dietician, { dataModel: 'plan-item' }));
  const dayPlan = await DayPlan.create({
    dietPlanId: plan._id,
    patientId: patient._id,
    week: 1,
    dayGroup,
  });
  const mealSlot = await MealSlotPlan.create({ dayPlanId: dayPlan._id, servingTime: slot });
  if (withItem) {
    await PlanItem.create({
      mealSlotId: mealSlot._id,
      recipeVersionId: new mongoose.Types.ObjectId(),
    });
  }
  return plan;
}

describe('runMealReminderSweep with plan-item plans', () => {
  test('notifies a plan-item patient who has the slot today', async () => {
    const dietician = await createDietician();
    const patient = await createPatient();
    await planItemPlan(patient, dietician, { slot: 'Breakfast', dayGroup: todayGroup() });

    const res = await runMealReminderSweep({ slot: 'Breakfast', now });

    expect(res.notified).toBe(1);
    const notifs = await Notification.find({ type: 'meal_reminder' }).lean();
    expect(notifs).toHaveLength(1);
    expect(notifs[0].userId.toString()).toBe(patient._id.toString());
  });

  test('does not notify when the slot is only on another day group', async () => {
    const dietician = await createDietician();
    const patient = await createPatient();
    await planItemPlan(patient, dietician, { slot: 'Breakfast', dayGroup: otherGroup() });

    const res = await runMealReminderSweep({ slot: 'Breakfast', now });

    expect(res.notified).toBe(0);
  });

  test('does not notify for an empty slot or a different slot', async () => {
    const dietician = await createDietician();
    const emptySlot = await createPatient();
    const otherSlot = await createPatient();
    await planItemPlan(emptySlot, dietician, {
      slot: 'Breakfast',
      dayGroup: todayGroup(),
      withItem: false,
    });
    await planItemPlan(otherSlot, dietician, { slot: 'Dinner', dayGroup: todayGroup() });

    const res = await runMealReminderSweep({ slot: 'Breakfast', now });

    expect(res.notified).toBe(0);
  });

  test('skips a plan-item patient who already logged the slot today', async () => {
    const dietician = await createDietician();
    const patient = await createPatient();
    await planItemPlan(patient, dietician, { slot: 'Lunch', dayGroup: todayGroup() });
    await MealLog.create({
      patientId: patient._id,
      date: now,
      dayKey,
      meals: [{ mealType: 'Lunch', servingTime: 'Lunch' }],
    });

    const res = await runMealReminderSweep({ slot: 'Lunch', now });

    expect(res.notified).toBe(0);
  });

  test('still notifies legacy days-array patients alongside plan-item ones', async () => {
    const dietician = await createDietician();
    const planItem = await createPatient();
    const legacy = await createPatient();
    await planItemPlan(planItem, dietician, { slot: 'Breakfast', dayGroup: todayGroup() });
    await DietPlan.create(
      basePlan(legacy, dietician, {
        finalizedPlan: { weeks: [{ week: 1, dailyMeals: [{ servingTime: 'Breakfast' }] }] },
      })
    );

    const res = await runMealReminderSweep({ slot: 'Breakfast', now });

    expect(res.notified).toBe(2);
    const ids = (await Notification.find({ type: 'meal_reminder' }).lean()).map((n) =>
      n.userId.toString()
    );
    expect(ids.sort()).toEqual([planItem._id.toString(), legacy._id.toString()].sort());
  });
});
