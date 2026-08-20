const { connectTestDb, disconnectTestDb } = require('./helpers/testDb');

let mongoose;
let DietPlan;
let balanceWeek;
let roundToStep;

beforeAll(async () => {
  await connectTestDb();
  mongoose = require('mongoose');
  ({ DietPlan } = require('../models'));
  ({ balanceWeek, roundToStep } = require('../services/dietPlanAutoBalanceService'));
});

afterAll(async () => {
  await disconnectTestDb();
});

function buildPlan({ tolerancePercent, servingMultiplier = 1, locked = false } = {}) {
  const recipeId = new mongoose.Types.ObjectId();
  return {
    plan: new DietPlan({
      patientId: new mongoose.Types.ObjectId(),
      dieticianId: new mongoose.Types.ObjectId(),
      targetProfile: tolerancePercent ? { tolerancePercent } : undefined,
      days: [
        {
          week: 1,
          dayGroup: 'Monday',
          meals: [
            { servingTime: 'Breakfast', items: [{ recipeId, servingMultiplier, locked }] },
          ],
        },
      ],
    }),
    recipeId,
  };
}

describe('balanceWeek', () => {
  test('recomputes calculatedNutrition from servingMultiplier and the recipe pool', () => {
    const { plan, recipeId } = buildPlan({ servingMultiplier: 2 });
    const recipesById = new Map([
      [recipeId.toString(), { nutritionPerServing: { calories: 200, protein: 10, carbs: 20, fats: 5, fiber: 2 } }],
    ]);

    balanceWeek({ dietPlan: plan, week: 1, recipesById, dailyCalorieTarget: 400 });

    const item = plan.days[0].meals[0].items[0];
    expect(item.calculatedNutrition).toEqual({ calories: 400, protein: 20, carbs: 40, fats: 10, fiber: 4 });
  });

  test('flags a day whose total falls outside the tolerance', () => {
    const { plan, recipeId } = buildPlan({ tolerancePercent: 10, servingMultiplier: 1 });
    const recipesById = new Map([[recipeId.toString(), { nutritionPerServing: { calories: 200 } }]]);

    const { warnings, tolerancePercent } = balanceWeek({
      dietPlan: plan,
      week: 1,
      recipesById,
      dailyCalorieTarget: 1000, // 200 actual vs 1000 target - way outside 10%
    });

    expect(tolerancePercent).toBe(10);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ week: 1, dayGroup: 'Monday', actualCalories: 200, targetCalories: 1000 });
    expect(warnings[0].deviationPercent).toBeLessThan(0); // under budget
  });

  test('does not flag a day within tolerance', () => {
    const { plan, recipeId } = buildPlan({ tolerancePercent: 10, servingMultiplier: 1 });
    const recipesById = new Map([[recipeId.toString(), { nutritionPerServing: { calories: 950 } }]]);

    const { warnings } = balanceWeek({ dietPlan: plan, week: 1, recipesById, dailyCalorieTarget: 1000 });
    expect(warnings).toEqual([]);
  });

  test('defaults to a 10% tolerance when targetProfile.tolerancePercent is unset', () => {
    const { plan, recipeId } = buildPlan({ servingMultiplier: 1 }); // no tolerancePercent
    const recipesById = new Map([[recipeId.toString(), { nutritionPerServing: { calories: 500 } }]]);
    const { tolerancePercent } = balanceWeek({ dietPlan: plan, week: 1, recipesById, dailyCalorieTarget: 1000 });
    expect(tolerancePercent).toBe(10);
  });

  test('suggests a corrective scale for unlocked items only, ignoring locked ones', () => {
    const recipeId = new mongoose.Types.ObjectId();
    const plan = new DietPlan({
      patientId: new mongoose.Types.ObjectId(),
      dieticianId: new mongoose.Types.ObjectId(),
      days: [
        {
          week: 1,
          dayGroup: 'Monday',
          meals: [
            {
              servingTime: 'Breakfast',
              items: [
                { recipeId, servingMultiplier: 1, locked: true }, // 300 cal, fixed
                { recipeId, servingMultiplier: 1, locked: false }, // 300 cal, adjustable
              ],
            },
          ],
        },
      ],
    });
    const recipesById = new Map([[recipeId.toString(), { nutritionPerServing: { calories: 300 } }]]);

    // Total = 600, target = 900 -> the 300 unlocked-cal portion needs to
    // become (900-300)=600 to hit target -> scale = 600/300 = 2.
    const { warnings } = balanceWeek({ dietPlan: plan, week: 1, recipesById, dailyCalorieTarget: 900 });
    expect(warnings[0].suggestedScaleForUnlocked).toBeCloseTo(2);
  });

  test('leaves a different week untouched', () => {
    const recipeId = new mongoose.Types.ObjectId();
    const plan = new DietPlan({
      patientId: new mongoose.Types.ObjectId(),
      dieticianId: new mongoose.Types.ObjectId(),
      days: [
        { week: 1, dayGroup: 'Monday', meals: [{ servingTime: 'Breakfast', items: [{ recipeId, servingMultiplier: 1 }] }] },
        { week: 2, dayGroup: 'Monday', meals: [{ servingTime: 'Breakfast', items: [{ recipeId, servingMultiplier: 1 }] }] },
      ],
    });
    const recipesById = new Map([[recipeId.toString(), { nutritionPerServing: { calories: 300 } }]]);

    balanceWeek({ dietPlan: plan, week: 1, recipesById, dailyCalorieTarget: 300 });
    // Schema default for an untouched item's calculatedNutrition.calories is
    // null (models/DietPlan.js), not undefined.
    expect(plan.days[1].meals[0].items[0].calculatedNutrition.calories).toBeNull();
  });
});

describe('roundToStep', () => {
  test('rounds to the nearest 0.25 by default', () => {
    expect(roundToStep(1.1)).toBe(1);
    expect(roundToStep(1.2)).toBe(1.25);
    expect(roundToStep(1.4)).toBe(1.5);
    expect(roundToStep(0.9)).toBe(1);
  });
});
