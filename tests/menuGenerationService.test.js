/**
 * services/menuGenerationService.js - Step 2's engine. Focus: only
 * versionNumber:1/Active/hasUnresolvedIngredients:false RecipeVersions are
 * ever selected (the Phase 0 data-coverage gate enforced in code), and
 * NON_VEG_ALLOWED_DAY_GROUPS gating parity with the old engine.
 */

const { connectTestDb, disconnectTestDb, clearTestDb } = require('./helpers/testDb');

let mongoose;
let Recipe;
let FoodItem;
let RecipeVersion;
let DietPlan;
let DayPlan;
let MealSlotPlan;
let PlanItem;
let generateMenu;
let buildEligibleV1Pool;

beforeAll(async () => {
  await connectTestDb();
  mongoose = require('mongoose');
  ({ Recipe, FoodItem, RecipeVersion, DietPlan, DayPlan, MealSlotPlan, PlanItem } = require('../models'));
  ({ generateMenu, buildEligibleV1Pool } = require('../services/menuGenerationService'));
});

afterEach(async () => {
  await clearTestDb();
});

afterAll(async () => {
  await disconnectTestDb();
});

async function makeFoodItem(name, calories = 300) {
  return FoodItem.create({
    name,
    normalizedName: name.toLowerCase(),
    nutritionPer100g: { calories, protein: 10, carbs: 30, fats: 5, fiber: 3 },
  });
}

async function makeResolvedRecipe({ dieticianId, name, servingTime, nonVegetarian = false, foodItem }) {
  const recipe = await Recipe.create({
    dieticianId,
    name,
    servingTime,
    components: [{ label: name, quantity: 100, unit: 'g' }],
    ingredients: [{ name: foodItem.name, quantity: 100, unit: 'g' }],
    nutrition: { calories: 300, protein: 10, carbs: 30, fats: 5, fiber: 3 },
    dietaryHabits: { nonVegetarian, vegetarian: !nonVegetarian },
  });
  await new Promise((resolve) => setTimeout(resolve, 50)); // let the post-save V1 sync hook land
  return recipe;
}

describe('buildEligibleV1Pool', () => {
  test('only includes recipes whose V1 is Active + fully resolved', async () => {
    const dieticianId = new mongoose.Types.ObjectId();
    const oats = await makeFoodItem('Oats');
    const resolved = await makeResolvedRecipe({ dieticianId, name: 'Resolved Dish', servingTime: 'Breakfast', foodItem: oats });

    // A recipe whose ingredient can't resolve to any FoodItem - V1 gets hasUnresolvedIngredients:true.
    const unresolved = await Recipe.create({
      dieticianId,
      name: 'Unresolved Dish',
      servingTime: 'Breakfast',
      ingredients: [{ name: 'Unobtainium Powder', quantity: 10, unit: 'g' }],
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    const pool = await buildEligibleV1Pool({ dieticianId });
    const poolRecipeIds = pool.map((c) => c.id);
    expect(poolRecipeIds).toContain(String(resolved._id));
    expect(poolRecipeIds).not.toContain(String(unresolved._id));
  });

  test('excludes recipes whose allergens overlap with the given allergies', async () => {
    const dieticianId = new mongoose.Types.ObjectId();
    const peanut = await makeFoodItem('Peanut');
    const recipe = await Recipe.create({
      dieticianId,
      name: 'Peanut Chikki',
      servingTime: 'Evening Snack',
      ingredients: [{ name: 'Peanut', quantity: 50, unit: 'g' }],
      allergens: ['nuts'],
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    const poolWithAllergy = await buildEligibleV1Pool({ dieticianId, allergies: ['nuts'] });
    expect(poolWithAllergy.map((c) => c.id)).not.toContain(String(recipe._id));

    const poolWithoutAllergy = await buildEligibleV1Pool({ dieticianId, allergies: [] });
    expect(poolWithoutAllergy.map((c) => c.id)).toContain(String(recipe._id));
  });
});

describe('generateMenu', () => {
  test('creates DayPlan/MealSlotPlan/PlanItem for every day-group and required serving time', async () => {
    const dieticianId = new mongoose.Types.ObjectId();
    const patientId = new mongoose.Types.ObjectId();
    const dietPlan = await DietPlan.create({ patientId, dieticianId, dataModel: 'plan-item' });
    const oats = await makeFoodItem('Oats');

    for (const servingTime of ['Morning Drink', 'Breakfast', 'Brunch', 'Lunch', 'Evening Snack', 'Dinner', 'Night Drink']) {
      await makeResolvedRecipe({ dieticianId, name: `${servingTime} Dish`, servingTime, foodItem: oats });
    }

    const { createdPlanItemIds, unfillableSlots } = await generateMenu({
      dietPlanId: dietPlan._id,
      patientId,
      dieticianId,
      weekNumbers: [1],
    });

    expect(unfillableSlots).toHaveLength(0);
    expect(createdPlanItemIds.length).toBeGreaterThan(0);

    const dayPlans = await DayPlan.find({ dietPlanId: dietPlan._id });
    expect(dayPlans).toHaveLength(4); // 4 DAY_GROUPS

    const allPlanItems = await PlanItem.find({ _id: { $in: createdPlanItemIds } });
    for (const item of allPlanItems) {
      const version = await RecipeVersion.findById(item.recipeVersionId);
      expect(version.versionNumber).toBe(1);
      expect(version.hasUnresolvedIngredients).toBe(false);
    }
  });

  test('an empty pool for a slot is reported as unfillable, not silently skipped', async () => {
    const dieticianId = new mongoose.Types.ObjectId();
    const patientId = new mongoose.Types.ObjectId();
    const dietPlan = await DietPlan.create({ patientId, dieticianId, dataModel: 'plan-item' });
    // No recipes at all for this dietician.

    const { unfillableSlots } = await generateMenu({ dietPlanId: dietPlan._id, patientId, dieticianId, weekNumbers: [1] });

    expect(unfillableSlots.length).toBeGreaterThan(0);
    expect(unfillableSlots[0]).toHaveProperty('servingTime');
  });

  test('non-veg recipes only fill slots on Monday/Wednesday day-groups when restrictNonVegToDayGroups is true', async () => {
    const dieticianId = new mongoose.Types.ObjectId();
    const patientId = new mongoose.Types.ObjectId();
    const dietPlan = await DietPlan.create({ patientId, dieticianId, dataModel: 'plan-item' });
    const chicken = await makeFoodItem('Chicken');
    await makeResolvedRecipe({ dieticianId, name: 'Chicken Curry', servingTime: 'Lunch', nonVegetarian: true, foodItem: chicken });
    // No vegetarian fallback for Lunch - Tuesday/Thursday's Lunch slot should end up unfillable.

    const { unfillableSlots } = await generateMenu({
      dietPlanId: dietPlan._id,
      patientId,
      dieticianId,
      weekNumbers: [1],
      restrictNonVegToDayGroups: true,
    });

    const unfillableLunchDayGroups = unfillableSlots.filter((s) => s.servingTime === 'Lunch').map((s) => s.dayGroup);
    expect(unfillableLunchDayGroups.sort()).toEqual(['Thursday', 'Tuesday']);
  });
});
