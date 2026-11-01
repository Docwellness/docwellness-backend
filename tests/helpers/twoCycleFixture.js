/**
 * A patient two plan cycles in: cycle 1 (Weeks 1-4) ended the day before cycle 2
 * (Weeks 5-8) started 6 days ago, so the Week 5 checkpoint falls on today.
 * Dates are UTC days relative to now, so the fixture never rots. The goal is
 * seeded the way production does it: from cycle 1, then extended by the
 * renewal (utils/seedGoalTimeline.js), so the goal now points at cycle 2.
 *
 * Weekly checkpoint dates: cycle 1 = today-28, -21, -14, -7 (Weeks 1-4),
 * cycle 2 = today (Week 5), +7, +14, +21.
 */
const MS_PER_DAY = 24 * 60 * 60 * 1000;

const utcDay = (offsetDays = 0) => {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) + offsetDays * MS_PER_DAY);
};
const dayKey = (date) => new Date(date).toISOString().slice(0, 10);

// `historyStartOffset` moves cycle 1's first day (and so the history start)
// further back, for tests that need a longer range.
async function createTwoCyclePatient({ startWeight = 75, targetWeight = 60, historyStartOffset = -34 } = {}) {
  const { DietPlan } = require('../../models');
  const { seedGoalTimeline } = require('../../utils/seedGoalTimeline');
  const { createPatient, createDietician, createDietPlanRequest } = require('./factories');

  const dietician = await createDietician();
  const patient = await createPatient({
    healthProfile: {
      bmi: 22,
      weightIndex: 0,
      weight: startWeight,
      height: 170,
      targetWeight: String(targetWeight),
    },
  });
  await createDietPlanRequest(patient, dietician, {
    status: 'Paid',
    hasActivePlan: true,
    subscriptionExpiresAt: utcDay(60),
  });

  const cycle1Start = utcDay(historyStartOffset);
  const cycle2Start = utcDay(-6);
  const makePlan = (cycleNumber, status, start) =>
    DietPlan.create({
      patientId: patient._id,
      dieticianId: dietician._id,
      status,
      cycleNumber,
      startDate: start,
      weekSchedule: [
        { week: 1, startDate: start, endDate: new Date(start.getTime() + 27 * MS_PER_DAY) },
      ],
    });
  const plan1 = await makePlan(1, 'Completed', cycle1Start);
  await seedGoalTimeline(plan1);
  const plan2 = await makePlan(2, 'Active', cycle2Start);
  const goal = await seedGoalTimeline(plan2);

  return { patient, dietician, plan1, plan2, goal, cycle1Start, cycle2Start };
}

// Day-group kcal steps below Monday's total: Mon/Fri, Tue/Sat, Wed/Sun, Thu.
const GROUP_STEP = { Monday: 0, Tuesday: 100, Wednesday: 200, Thursday: 300 };
const GROUP_OF_WEEKDAY = { 1: 'Monday', 5: 'Monday', 2: 'Tuesday', 6: 'Tuesday', 3: 'Wednesday', 0: 'Wednesday', 4: 'Thursday' };

/** The kcal an older-plan cycle seeded by `addCycleMeals` plans for `date`. */
const plannedKcalFor = (mondayKcal, date) => mondayKcal - GROUP_STEP[GROUP_OF_WEEKDAY[new Date(date).getUTCDay()]];

/**
 * Gives each cycle's plan one week of meals (an older finalizedPlan blob) so
 * its day-groups plan `monday`, `monday - 100`, `- 200` and `- 300` kcal: one
 * recipe of 1000 kcal per 100 g, served at kcal / 10 g.
 */
async function addCycleMeals({ dietician, plan1, plan2 }, { cycle1Monday = 1800, cycle2Monday = 1600 } = {}) {
  const { DietPlan, Recipe } = require('../../models');
  const recipe = await Recipe.create({
    dieticianId: dietician._id,
    name: 'Rice',
    servingTime: 'Lunch',
    servingSize: { quantity: 100, unit: 'g' },
    components: [{ label: 'Rice', quantity: 100, unit: 'g' }],
    nutrition: { calories: 1000, protein: 10, carbs: 10, fats: 10, fiber: 1 },
  });
  const weeksFor = (monday) => [
    {
      week: 1,
      dailyMeals: Object.entries(GROUP_STEP).map(([dayGroup, step]) => ({
        dayGroup,
        servingTime: 'Lunch',
        recipeId: recipe._id.toString(),
        servings: (monday - step) / 10,
      })),
    },
  ];
  await DietPlan.updateOne({ _id: plan1._id }, { finalizedPlan: { weeks: weeksFor(cycle1Monday) } });
  await DietPlan.updateOne({ _id: plan2._id }, { finalizedPlan: { weeks: weeksFor(cycle2Monday) } });
}

module.exports = { createTwoCyclePatient, addCycleMeals, plannedKcalFor, utcDay, dayKey, MS_PER_DAY };
