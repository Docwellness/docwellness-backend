/**
 * services/recipeVersionSwapService.js - swapToRecipe (the v4.0 swap path)
 * and findSwapAlternatives (moved here from the deleted
 * services/recipeSwapEngine.js as part of v4.0's hard cutover - see that
 * service's header comment).
 */

const { connectTestDb, disconnectTestDb, clearTestDb } = require('./helpers/testDb');

let mongoose;
let RecipeVersion;
let PlanItem;
let MealSlotPlan;
let DayPlan;
let DietPlan;
let swapToRecipe;
let findSwapAlternatives;

beforeAll(async () => {
  await connectTestDb();
  mongoose = require('mongoose');
  ({ RecipeVersion, PlanItem, MealSlotPlan, DayPlan, DietPlan } = require('../models'));
  ({ swapToRecipe, findSwapAlternatives } = require('../services/recipeVersionSwapService'));
});

afterEach(async () => {
  await clearTestDb();
});

afterAll(async () => {
  await disconnectTestDb();
});

async function makePlanItem() {
  const patientId = new mongoose.Types.ObjectId();
  const dieticianId = new mongoose.Types.ObjectId();
  const dietPlan = await DietPlan.create({ patientId, dieticianId, dataModel: 'plan-item' });
  const dayPlan = await DayPlan.create({ dietPlanId: dietPlan._id, patientId, week: 1, dayGroup: 'Monday' });
  const mealSlot = await MealSlotPlan.create({ dayPlanId: dayPlan._id, servingTime: 'Breakfast' });

  const oldRecipeId = new mongoose.Types.ObjectId();
  const oldV1 = await RecipeVersion.create({
    name: 'Oats Porridge',
    parentRecipeId: oldRecipeId,
    versionNumber: 1,
    ingredients: [],
    nutritionPerServing: { calories: 300, protein: 10, carbs: 40, fats: 5, fiber: 5 },
    status: 'Active',
  });
  const planItem = await PlanItem.create({ mealSlotId: mealSlot._id, recipeVersionId: oldV1._id, calculatedNutrition: oldV1.nutritionPerServing });
  return { planItem, oldV1 };
}

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

describe('swapToRecipe', () => {
  test('repoints the PlanItem at the new recipe\'s V1, using it as-authored (no rescale)', async () => {
    const { planItem } = await makePlanItem();
    const newRecipeId = new mongoose.Types.ObjectId();
    const newV1 = await RecipeVersion.create({
      name: 'Poha',
      parentRecipeId: newRecipeId,
      versionNumber: 1,
      ingredients: [],
      nutritionPerServing: { calories: 250, protein: 6, carbs: 45, fats: 4, fiber: 3 },
      status: 'Active',
    });

    const updated = await swapToRecipe(planItem._id, newRecipeId);

    expect(String(updated.recipeVersionId)).toBe(String(newV1._id));
    expect(updated.calculatedNutrition.calories).toBe(250);
  });

  test('throws if the target recipe has no Active V1', async () => {
    const { planItem } = await makePlanItem();
    const newRecipeId = new mongoose.Types.ObjectId();

    await expect(swapToRecipe(planItem._id, newRecipeId)).rejects.toThrow('No Active V1');
  });

  test('throws if the target V1 has unresolved ingredients', async () => {
    const { planItem } = await makePlanItem();
    const newRecipeId = new mongoose.Types.ObjectId();
    await RecipeVersion.create({
      name: 'Mystery Dish',
      parentRecipeId: newRecipeId,
      versionNumber: 1,
      ingredients: [],
      nutritionPerServing: { calories: null, protein: null, carbs: null, fats: null, fiber: null },
      hasUnresolvedIngredients: true,
      status: 'Active',
    });

    await expect(swapToRecipe(planItem._id, newRecipeId)).rejects.toThrow('unresolved ingredients');
  });
});
