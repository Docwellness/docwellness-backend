const { connectTestDb, disconnectTestDb } = require('./helpers/testDb');

let mongoose;
let DietPlan;
let findSwapAlternatives;
let applySwap;
let applyScale;
let findItem;

beforeAll(async () => {
  await connectTestDb();
  mongoose = require('mongoose');
  ({ DietPlan } = require('../models'));
  ({ findSwapAlternatives, applySwap, applyScale, findItem } = require('../services/recipeSwapEngine'));
});

afterAll(async () => {
  await disconnectTestDb();
});

describe('findSwapAlternatives', () => {
  const pool = [
    { id: 'main', servingTime: 'Lunch', calories: 500 },
    { id: 'lighter1', servingTime: 'Lunch', calories: 380 }, // 76% of 500 - eligible
    { id: 'lighter2', servingTime: 'Lunch', calories: 200 }, // 40% - eligible, further away
    { id: 'notLighEnough', servingTime: 'Lunch', calories: 450 }, // 90% - not eligible
    { id: 'heavier1', servingTime: 'Lunch', calories: 650 }, // 130% - eligible for 'heavier'
    { id: 'wrongSlot', servingTime: 'Breakfast', calories: 100 },
  ];

  test('lighter: only candidates at or below 80% of current calories, sorted by proximity', () => {
    const results = findSwapAlternatives({
      recipePool: pool,
      servingTime: 'Lunch',
      currentCalories: 500,
      direction: 'lighter',
      excludeRecipeId: 'main',
    });
    expect(results.map((r) => r.id)).toEqual(['lighter1', 'lighter2']);
  });

  test('heavier: only candidates at or above 120% of current calories', () => {
    const results = findSwapAlternatives({
      recipePool: pool,
      servingTime: 'Lunch',
      currentCalories: 500,
      direction: 'heavier',
      excludeRecipeId: 'main',
    });
    expect(results.map((r) => r.id)).toEqual(['heavier1']);
  });

  test('never includes the excluded (current) recipe', () => {
    const results = findSwapAlternatives({
      recipePool: pool,
      servingTime: 'Lunch',
      currentCalories: 500,
      direction: 'lighter',
      excludeRecipeId: 'main',
    });
    expect(results.map((r) => r.id)).not.toContain('main');
  });

  test('never includes a candidate from a different servingTime', () => {
    const results = findSwapAlternatives({
      recipePool: pool,
      servingTime: 'Lunch',
      currentCalories: 500,
      direction: null,
      excludeRecipeId: 'main',
    });
    expect(results.map((r) => r.id)).not.toContain('wrongSlot');
  });

  test('respects the limit', () => {
    const results = findSwapAlternatives({
      recipePool: pool,
      servingTime: 'Lunch',
      currentCalories: 500,
      direction: null,
      excludeRecipeId: 'main',
      limit: 2,
    });
    expect(results.length).toBeLessThanOrEqual(2);
  });
});

function buildPlanWithItem() {
  const oldRecipeId = new mongoose.Types.ObjectId();
  const plan = new DietPlan({
    patientId: new mongoose.Types.ObjectId(),
    dieticianId: new mongoose.Types.ObjectId(),
    days: [
      {
        week: 1,
        dayGroup: 'Monday',
        meals: [{ servingTime: 'Lunch', items: [{ recipeId: oldRecipeId, servingMultiplier: 2 }] }],
      },
    ],
  });
  const itemId = plan.days[0].meals[0].items[0]._id.toString();
  return { plan, oldRecipeId, itemId };
}

describe('findItem', () => {
  test('locates an item by week/dayGroup/servingTime/itemId', () => {
    const { plan, itemId, oldRecipeId } = buildPlanWithItem();
    const item = findItem({ dietPlan: plan, week: 1, dayGroup: 'Monday', servingTime: 'Lunch', itemId });
    expect(item.recipeId.toString()).toBe(oldRecipeId.toString());
  });

  test('throws when no such item exists', () => {
    const { plan } = buildPlanWithItem();
    expect(() =>
      findItem({ dietPlan: plan, week: 9, dayGroup: 'Monday', servingTime: 'Lunch', itemId: 'nope' })
    ).toThrow();
  });
});

describe('applySwap', () => {
  test('replaces the recipe, records swapHistory, and recomputes nutrition', () => {
    const { plan, oldRecipeId, itemId } = buildPlanWithItem();
    const newRecipe = { _id: new mongoose.Types.ObjectId(), name: 'Lighter Dal', nutritionPerServing: { calories: 150 } };

    const item = applySwap({
      dietPlan: plan,
      week: 1,
      dayGroup: 'Monday',
      servingTime: 'Lunch',
      itemId,
      newRecipe,
      reason: 'too heavy',
    });

    expect(item.recipeId.toString()).toBe(newRecipe._id.toString());
    expect(item.displayText).toBe('Lighter Dal');
    expect(item.calculatedNutrition.calories).toBe(300); // 150 * servingMultiplier(2)
    expect(item.swapHistory).toHaveLength(1);
    expect(item.swapHistory[0]).toMatchObject({
      fromRecipeId: oldRecipeId,
      toRecipeId: newRecipe._id,
      reason: 'too heavy',
    });
  });
});

describe('applyScale', () => {
  test('updates servingMultiplier and recomputes nutrition from the given recipe', () => {
    const { plan, itemId } = buildPlanWithItem();
    const recipe = { nutritionPerServing: { calories: 200 } };

    const item = applyScale({
      dietPlan: plan,
      week: 1,
      dayGroup: 'Monday',
      servingTime: 'Lunch',
      itemId,
      newMultiplier: 1.5,
      recipe,
    });

    expect(item.servingMultiplier).toBe(1.5);
    expect(item.calculatedNutrition.calories).toBe(300); // 200 * 1.5
  });

  test('throws for a non-positive multiplier', () => {
    const { plan, itemId } = buildPlanWithItem();
    expect(() =>
      applyScale({ dietPlan: plan, week: 1, dayGroup: 'Monday', servingTime: 'Lunch', itemId, newMultiplier: 0 })
    ).toThrow();
  });
});
