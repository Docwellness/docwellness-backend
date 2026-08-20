/**
 * services/recipeVersioningService.js's syncV1FromRecipe - the auto-V1-
 * creation hook fired from Recipe.js's post-save hook. Uses the real DB
 * (mongodb-memory-server) since this needs real save()/post-save-hook
 * behavior, not just in-memory document mutation.
 */

const { connectTestDb, disconnectTestDb, clearTestDb } = require('./helpers/testDb');

let mongoose;
let Recipe;
let FoodItem;
let RecipeVersion;
let PlanItem;
let MealSlotPlan;
let DayPlan;
let DietPlan;
let syncV1FromRecipe;

beforeAll(async () => {
  await connectTestDb();
  mongoose = require('mongoose');
  ({ Recipe, FoodItem, RecipeVersion, PlanItem, MealSlotPlan, DayPlan, DietPlan } = require('../models'));
  ({ syncV1FromRecipe } = require('../services/recipeVersioningService'));
});

afterEach(async () => {
  await clearTestDb();
});

afterAll(async () => {
  await disconnectTestDb();
});

async function makeFoodItem(overrides = {}) {
  return FoodItem.create({
    name: 'Oats',
    normalizedName: 'oats',
    nutritionPer100g: { calories: 389, protein: 17, carbs: 66, fats: 7, fiber: 10 },
    dataSource: 'tier1-seed',
    ...overrides,
  });
}

async function makeRecipe(overrides = {}) {
  const dieticianId = new mongoose.Types.ObjectId();
  return Recipe.create({
    dieticianId,
    name: 'Oats Porridge',
    servingTime: 'Breakfast',
    components: [{ label: 'Oats Porridge', quantity: 250, unit: 'g' }],
    ingredients: [{ name: 'Oats', quantity: 250, unit: 'g' }],
    nutrition: { calories: 300, protein: 10, carbs: 50, fats: 5, fiber: 5 },
    ...overrides,
  });
}

describe('syncV1FromRecipe (via Recipe post-save hook)', () => {
  test('auto-creates a versionNumber:1 RecipeVersion with real per-ingredient nutrition on recipe save', async () => {
    await makeFoodItem();
    const recipe = await makeRecipe();

    // Post-save hook is fire-and-forget - poll briefly for it to land.
    await new Promise((resolve) => setTimeout(resolve, 200));

    const v1 = await RecipeVersion.findOne({ parentRecipeId: recipe._id, versionNumber: 1 });
    expect(v1).toBeTruthy();
    expect(v1.hasUnresolvedIngredients).toBe(false);
    expect(v1.ingredients).toHaveLength(1);
    // 250g oats @ 389 kcal/100g = 972.5
    expect(v1.nutritionPerServing.calories).toBeCloseTo(972.5);
    expect(v1.nutritionPerServing.protein).toBeCloseTo((17 / 100) * 250);
  });

  test('flags hasUnresolvedIngredients when an ingredient name matches no FoodItem', async () => {
    const recipe = await makeRecipe({ ingredients: [{ name: 'Unobtainium Powder', quantity: 10, unit: 'g' }] });
    const v1 = await syncV1FromRecipe(recipe);

    expect(v1.hasUnresolvedIngredients).toBe(true);
    expect(v1.unresolvedIngredientNames).toContain('Unobtainium Powder');
    expect(v1.ingredients).toHaveLength(0);
    expect(v1.nutritionPerServing.calories).toBeNull();
  });

  test('re-syncing before any PlanItem references V1 upserts in place (no duplicate version:1 docs)', async () => {
    await makeFoodItem();
    const recipe = await makeRecipe();
    const first = await syncV1FromRecipe(recipe);

    recipe.ingredients[0].quantity = 300;
    const second = await syncV1FromRecipe(recipe);

    expect(String(second._id)).toBe(String(first._id));
    const allVersions = await RecipeVersion.find({ parentRecipeId: recipe._id });
    expect(allVersions).toHaveLength(1);
    expect(allVersions[0].versionNumber).toBe(1);
    // 300g oats @ 389 kcal/100g = 1167
    expect(allVersions[0].nutritionPerServing.calories).toBeCloseTo(1167);
  });

  test('re-syncing AFTER a PlanItem references V1 creates a new version instead of mutating it', async () => {
    await makeFoodItem();
    const recipe = await makeRecipe();
    const v1 = await syncV1FromRecipe(recipe);
    const v1SnapshotCalories = v1.nutritionPerServing.calories;

    // Simulate this V1 having been prescribed to a real patient.
    const patientId = new mongoose.Types.ObjectId();
    const dietPlan = await DietPlan.create({ patientId, dieticianId: recipe.dieticianId, dataModel: 'plan-item' });
    const dayPlan = await DayPlan.create({ dietPlanId: dietPlan._id, patientId, week: 1, dayGroup: 'Monday' });
    const mealSlot = await MealSlotPlan.create({ dayPlanId: dayPlan._id, servingTime: 'Breakfast' });
    await PlanItem.create({ mealSlotId: mealSlot._id, recipeVersionId: v1._id });

    recipe.ingredients[0].quantity = 999; // a later, unrelated edit to the master recipe
    const second = await syncV1FromRecipe(recipe);

    expect(String(second._id)).not.toBe(String(v1._id));
    expect(second.versionNumber).toBe(2);

    // The original V1 document is byte-for-byte unchanged.
    const v1Reloaded = await RecipeVersion.findById(v1._id);
    expect(v1Reloaded.nutritionPerServing.calories).toBeCloseTo(v1SnapshotCalories);
    expect(v1Reloaded.ingredients[0].rawQuantity).toBe(250);
  });

  test('a recipe with no ingredients produces no RecipeVersion', async () => {
    const recipe = await makeRecipe({ ingredients: [] });
    const result = await syncV1FromRecipe(recipe);
    expect(result).toBeNull();
    expect(await RecipeVersion.countDocuments({ parentRecipeId: recipe._id })).toBe(0);
  });
});
