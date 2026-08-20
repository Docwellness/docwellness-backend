const { connectTestDb, disconnectTestDb } = require('./helpers/testDb');

let mongoose;
let DietPlan;
let syncRecipeChange;
let isWeekUpcoming;

beforeAll(async () => {
  await connectTestDb();
  mongoose = require('mongoose');
  ({ DietPlan } = require('../models'));
  ({ syncRecipeChange, isWeekUpcoming } = require('../services/smartSyncService'));
});

afterAll(async () => {
  await disconnectTestDb();
});

function futureDate(daysFromNow) {
  return new Date(Date.now() + daysFromNow * 24 * 60 * 60 * 1000);
}

function buildPlan({ recipeId, week1StartsInFuture, week2StartsInFuture }) {
  return new DietPlan({
    patientId: new mongoose.Types.ObjectId(),
    dieticianId: new mongoose.Types.ObjectId(),
    status: 'Active',
    weekSchedule: [
      { week: 1, startDate: futureDate(week1StartsInFuture ? 3 : -10), endDate: futureDate(week1StartsInFuture ? 10 : -3) },
      { week: 2, startDate: futureDate(week2StartsInFuture ? 10 : -3), endDate: futureDate(week2StartsInFuture ? 17 : 4) },
    ],
    days: [
      {
        week: 1,
        dayGroup: 'Monday',
        meals: [{ servingTime: 'Lunch', items: [{ recipeId, servingMultiplier: 2 }] }],
      },
      {
        week: 2,
        dayGroup: 'Monday',
        meals: [{ servingTime: 'Lunch', items: [{ recipeId, servingMultiplier: 1 }] }],
      },
    ],
  });
}

describe('isWeekUpcoming', () => {
  test('true when the week\'s startDate is in the future', () => {
    const plan = buildPlan({ recipeId: new mongoose.Types.ObjectId(), week1StartsInFuture: true });
    expect(isWeekUpcoming(plan, 1)).toBe(true);
  });

  test('false when the week already started', () => {
    const plan = buildPlan({ recipeId: new mongoose.Types.ObjectId(), week1StartsInFuture: false });
    expect(isWeekUpcoming(plan, 1)).toBe(false);
  });

  test('false (conservative) when there is no schedule entry for the week', () => {
    const plan = buildPlan({ recipeId: new mongoose.Types.ObjectId(), week1StartsInFuture: true });
    expect(isWeekUpcoming(plan, 99)).toBe(false);
  });
});

describe('syncRecipeChange', () => {
  test('recomputes items referencing the changed recipe in upcoming weeks only', () => {
    const recipeId = new mongoose.Types.ObjectId();
    const plan = buildPlan({ recipeId, week1StartsInFuture: false, week2StartsInFuture: true });

    const { plansTouched } = syncRecipeChange({
      plans: [plan],
      recipeId,
      updatedNutritionPerServing: { calories: 250, protein: 12, carbs: 25, fats: 8, fiber: 3 },
    });

    expect(plansTouched).toHaveLength(1);
    expect(plansTouched[0].changedItems).toEqual([
      expect.objectContaining({ week: 2, dayGroup: 'Monday', servingTime: 'Lunch' }),
    ]);

    // Week 1 (already started) is untouched.
    expect(plan.days[0].meals[0].items[0].calculatedNutrition.calories).toBeNull();
    // Week 2 (upcoming) got recomputed: 250 * servingMultiplier(1).
    expect(plan.days[1].meals[0].items[0].calculatedNutrition.calories).toBe(250);
  });

  test('ignores items referencing a different recipe', () => {
    const targetRecipeId = new mongoose.Types.ObjectId();
    const otherRecipeId = new mongoose.Types.ObjectId();
    const plan = buildPlan({ recipeId: otherRecipeId, week1StartsInFuture: true, week2StartsInFuture: true });

    const { plansTouched } = syncRecipeChange({
      plans: [plan],
      recipeId: targetRecipeId,
      updatedNutritionPerServing: { calories: 999 },
    });

    expect(plansTouched).toEqual([]);
  });

  test('omits a plan with no matching upcoming items from plansTouched', () => {
    const recipeId = new mongoose.Types.ObjectId();
    const plan = buildPlan({ recipeId, week1StartsInFuture: false, week2StartsInFuture: false }); // both already started

    const { plansTouched } = syncRecipeChange({
      plans: [plan],
      recipeId,
      updatedNutritionPerServing: { calories: 250 },
    });

    expect(plansTouched).toEqual([]);
  });
});
