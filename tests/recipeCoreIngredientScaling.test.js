/**
 * recipe-core-ingredient-scaling: services/recipeVersioningService.js's
 * syncV1FromRecipe (role copied from Recipe -> V1 RecipeVersion) and
 * createCustomVersion (core-ingredient-group aggregate-weight recompute
 * of sub ingredients). See openspec/changes/recipe-core-ingredient-scaling.
 */

const { connectTestDb, disconnectTestDb, clearTestDb } = require('./helpers/testDb');

jest.mock('../utils/openaiClient', () => ({
  rewriteRecipeStepsForIngredients: jest.fn(),
}));
jest.mock('../utils/supabaseAuth');
const { registerTestToken, clearTestTokens } = require('../utils/supabaseAuth');

let mongoose;
let FoodItem;
let Recipe;
let RecipeVersion;
let createCustomVersion;
let syncV1FromRecipe;
let createVersionFromSnapshot;
let request;
let app;
let createPatient;
let createDietician;
let DietPlan;
let DayPlan;
let MealSlotPlan;
let PlanItem;

beforeAll(async () => {
  await connectTestDb();
  mongoose = require('mongoose');
  ({ FoodItem, Recipe, RecipeVersion, DietPlan, DayPlan, MealSlotPlan, PlanItem } = require('../models'));
  ({ createCustomVersion, syncV1FromRecipe, createVersionFromSnapshot } = require('../services/recipeVersioningService'));
  request = require('supertest');
  app = require('../config/createApp')();
  ({ createPatient, createDietician } = require('./helpers/factories'));
});

afterEach(async () => {
  clearTestTokens();
  await clearTestDb();
});

afterAll(async () => {
  await disconnectTestDb();
});

describe('syncV1FromRecipe - role copy', () => {
  test("V1's ingredient roles match the parent Recipe's, matched by foodItemId", async () => {
    const flour = await FoodItem.create({ name: 'Whole Wheat Flour', normalizedName: 'whole wheat flour', nutritionPer100g: { calories: 340, protein: 12, carbs: 70, fats: 2, fiber: 11 } });
    const water = await FoodItem.create({ name: 'Water', normalizedName: 'water', nutritionPer100g: { calories: 0, protein: 0, carbs: 0, fats: 0, fiber: 0 } });

    const recipe = await Recipe.create({
      dieticianId: new mongoose.Types.ObjectId(),
      name: 'Chapati',
      servingTime: 'Lunch',
      ingredients: [
        { name: 'Whole Wheat Flour', quantity: 100, unit: 'g', role: 'core' },
        { name: 'Water', quantity: 60, unit: 'g', role: 'sub' },
      ],
    });

    await syncV1FromRecipe(recipe);
    const v1 = await RecipeVersion.findOne({ parentRecipeId: recipe._id, versionNumber: 1 });
    const byFoodItemId = Object.fromEntries(v1.ingredients.map((i) => [String(i.foodItemId), i.role]));
    expect(byFoodItemId[String(flour._id)]).toBe('core');
    expect(byFoodItemId[String(water._id)]).toBe('sub');
  });
});

describe('createCustomVersion - core ingredient group recompute', () => {
  async function makeChapatiV1() {
    const flour = await FoodItem.create({ name: 'Whole Wheat Flour', normalizedName: 'wwf', nutritionPer100g: { calories: 340, protein: 12, carbs: 70, fats: 2, fiber: 11 } });
    const water = await FoodItem.create({ name: 'Water', normalizedName: 'water', nutritionPer100g: { calories: 0, protein: 0, carbs: 0, fats: 0, fiber: 0 } });
    const salt = await FoodItem.create({ name: 'Salt', normalizedName: 'salt', nutritionPer100g: { calories: 0, protein: 0, carbs: 0, fats: 0, fiber: 0 } });
    const v1 = await RecipeVersion.create({
      name: 'Chapati',
      parentRecipeId: new mongoose.Types.ObjectId(),
      versionNumber: 1,
      ingredients: [
        { foodItemId: flour._id, rawQuantity: 100, unit: 'g', role: 'core' },
        { foodItemId: water._id, rawQuantity: 60, unit: 'g', role: 'sub' },
        { foodItemId: salt._id, rawQuantity: 5, unit: 'g', role: 'sub' },
      ],
      components: [{ label: 'Chapati', quantity: 2, unit: 'piece' }],
      nutritionPerServing: { calories: 340, protein: 12, carbs: 70, fats: 2, fiber: 11 },
      status: 'Active',
    });
    return { v1, flour, water, salt };
  }

  test('doubling the single core ingredient doubles every sub ingredient, ignoring what was submitted for them', async () => {
    const { v1, flour, water, salt } = await makeChapatiV1();

    const v2 = await createCustomVersion(v1._id, [
      { foodItemId: flour._id, rawQuantity: 200, unit: 'g' }, // 100 -> 200, exactly 2x
      { foodItemId: water._id, rawQuantity: 1, unit: 'g' }, // attempted override - should be discarded
      { foodItemId: salt._id, rawQuantity: 1, unit: 'g' }, // attempted override - should be discarded
    ]);

    const byId = Object.fromEntries(v2.toObject().ingredients.map((i) => [String(i.foodItemId), i]));
    expect(byId[String(flour._id)].rawQuantity).toBe(200);
    expect(byId[String(water._id)].rawQuantity).toBe(120); // 60 * 2
    expect(byId[String(salt._id)].rawQuantity).toBe(10); // 5 * 2
    expect(byId[String(flour._id)].role).toBe('core');
    expect(byId[String(water._id)].role).toBe('sub');
  });

  test('sub ingredient quantity submitted alongside an UNCHANGED core is honored verbatim (deliberate override)', async () => {
    const { v1, flour, water, salt } = await makeChapatiV1();

    const v2 = await createCustomVersion(v1._id, [
      { foodItemId: flour._id, rawQuantity: 100, unit: 'g' }, // unchanged
      { foodItemId: water._id, rawQuantity: 999, unit: 'g' }, // deliberate override
      { foodItemId: salt._id, rawQuantity: 5, unit: 'g' },
    ]);

    const byId = Object.fromEntries(v2.toObject().ingredients.map((i) => [String(i.foodItemId), i]));
    expect(byId[String(water._id)].rawQuantity).toBe(999);
  });

  test('an overridden sub value becomes the baseline the NEXT edit is computed from', async () => {
    const { v1, flour, water, salt } = await makeChapatiV1();

    const v2 = await createCustomVersion(v1._id, [
      { foodItemId: flour._id, rawQuantity: 100, unit: 'g' },
      { foodItemId: water._id, rawQuantity: 30, unit: 'g' }, // override: halved
      { foodItemId: salt._id, rawQuantity: 5, unit: 'g' },
    ]);

    const v3 = await createCustomVersion(v2._id, [
      { foodItemId: flour._id, rawQuantity: 200, unit: 'g' }, // now double
      { foodItemId: water._id, rawQuantity: 1, unit: 'g' }, // attempted override, discarded
      { foodItemId: salt._id, rawQuantity: 1, unit: 'g' },
    ]);

    const byId = Object.fromEntries(v3.toObject().ingredients.map((i) => [String(i.foodItemId), i]));
    expect(byId[String(water._id)].rawQuantity).toBe(60); // 30 (V2's baseline) * 2, not 60 (V1's) * 2
  });

  test('a recipe with no core ingredient designated passes every submitted quantity through unchanged (legacy behavior)', async () => {
    const flour = await FoodItem.create({ name: 'Rice', normalizedName: 'rice-legacy', nutritionPer100g: { calories: 130, protein: 2.7, carbs: 28, fats: 0.3, fiber: 0.4 } });
    const salt = await FoodItem.create({ name: 'Salt', normalizedName: 'salt-legacy', nutritionPer100g: { calories: 0, protein: 0, carbs: 0, fats: 0, fiber: 0 } });
    const v1 = await RecipeVersion.create({
      name: 'Legacy Recipe',
      parentRecipeId: new mongoose.Types.ObjectId(),
      versionNumber: 1,
      ingredients: [
        { foodItemId: flour._id, rawQuantity: 100, unit: 'g' }, // role defaults to 'sub' - nothing core
        { foodItemId: salt._id, rawQuantity: 5, unit: 'g' },
      ],
      status: 'Active',
    });

    const v2 = await createCustomVersion(v1._id, [
      { foodItemId: flour._id, rawQuantity: 300, unit: 'g' }, // tripled
      { foodItemId: salt._id, rawQuantity: 5, unit: 'g' }, // unchanged, submitted as-is
    ]);

    const byId = Object.fromEntries(v2.toObject().ingredients.map((i) => [String(i.foodItemId), i]));
    expect(byId[String(salt._id)].rawQuantity).toBe(5); // no recompute happened
  });

  test('an unresolvable core-ingredient unit falls back to full pass-through, not a partial/wrong total', async () => {
    // No unitConversions.piece entry - a 'piece'-unit core ingredient can't
    // be converted to grams.
    const paneer = await FoodItem.create({ name: 'Paneer Cube', normalizedName: 'paneer-cube', nutritionPer100g: { calories: 265, protein: 18, carbs: 1.2, fats: 20, fiber: 0 } });
    const salt = await FoodItem.create({ name: 'Salt', normalizedName: 'salt-unresolvable', nutritionPer100g: { calories: 0, protein: 0, carbs: 0, fats: 0, fiber: 0 } });
    const v1 = await RecipeVersion.create({
      name: 'Paneer Dish',
      parentRecipeId: new mongoose.Types.ObjectId(),
      versionNumber: 1,
      ingredients: [
        { foodItemId: paneer._id, rawQuantity: 4, unit: 'piece', role: 'core' },
        { foodItemId: salt._id, rawQuantity: 5, unit: 'g', role: 'sub' },
      ],
      status: 'Active',
    });

    const v2 = await createCustomVersion(v1._id, [
      { foodItemId: paneer._id, rawQuantity: 8, unit: 'piece' }, // doubled
      { foodItemId: salt._id, rawQuantity: 5, unit: 'g' }, // submitted unchanged
    ]);

    const byId = Object.fromEntries(v2.toObject().ingredients.map((i) => [String(i.foodItemId), i]));
    expect(byId[String(salt._id)].rawQuantity).toBe(5); // pass-through, not scaled
  });

  test('components ("Makes on the plate") still rescale by the resulting calorie ratio after a core-triggered recompute', async () => {
    const { v1, flour, water, salt } = await makeChapatiV1(); // 2 piece @ ~340 cal (V1's stored nutritionPerServing)

    const v2 = await createCustomVersion(v1._id, [
      { foodItemId: flour._id, rawQuantity: 200, unit: 'g' }, // doubled -> subs also double via recompute
      { foodItemId: water._id, rawQuantity: 1, unit: 'g' },
      { foodItemId: salt._id, rawQuantity: 1, unit: 'g' },
    ]);

    // New calories should be ~2x the flour-only contribution's macro base
    // (680 vs V1's stored 340), so components should scale ~2x too (1 piece -> ~4).
    const [component] = v2.toObject().components;
    expect(component.quantity).toBeCloseTo(4, 0);
  });
});

describe('createCustomVersion - multi-core ingredient group recompute (Mixed Vegetable-style)', () => {
  async function makeMixedVegV1() {
    const carrot = await FoodItem.create({ name: 'Carrot', normalizedName: 'carrot', nutritionPer100g: { calories: 41, protein: 0.9, carbs: 10, fats: 0.2, fiber: 2.8 } });
    const peas = await FoodItem.create({ name: 'Peas', normalizedName: 'peas', nutritionPer100g: { calories: 81, protein: 5, carbs: 14, fats: 0.4, fiber: 5 } });
    const beans = await FoodItem.create({ name: 'Beans', normalizedName: 'beans', nutritionPer100g: { calories: 31, protein: 1.8, carbs: 7, fats: 0.2, fiber: 3.4 } });
    const oil = await FoodItem.create({ name: 'Oil', normalizedName: 'oil', nutritionPer100g: { calories: 884, protein: 0, carbs: 0, fats: 100, fiber: 0 } });
    const v1 = await RecipeVersion.create({
      name: 'Mixed Vegetable',
      parentRecipeId: new mongoose.Types.ObjectId(),
      versionNumber: 1,
      ingredients: [
        { foodItemId: carrot._id, rawQuantity: 100, unit: 'g', role: 'core' },
        { foodItemId: peas._id, rawQuantity: 100, unit: 'g', role: 'core' },
        { foodItemId: beans._id, rawQuantity: 100, unit: 'g', role: 'core' },
        { foodItemId: oil._id, rawQuantity: 10, unit: 'g', role: 'sub' },
      ],
      status: 'Active',
    });
    return { v1, carrot, peas, beans, oil };
  }

  test('growing the core group total (via just ONE of several core ingredients) scales sub ingredients by that total ratio', async () => {
    const { v1, carrot, peas, beans, oil } = await makeMixedVegV1(); // total core = 300g

    const v2 = await createCustomVersion(v1._id, [
      { foodItemId: carrot._id, rawQuantity: 250, unit: 'g' }, // 100 -> 250
      { foodItemId: peas._id, rawQuantity: 100, unit: 'g' }, // unchanged
      { foodItemId: beans._id, rawQuantity: 100, unit: 'g' }, // unchanged
      { foodItemId: oil._id, rawQuantity: 1, unit: 'g' }, // attempted override, discarded
    ]);

    // new total = 450g, ratio = 450/300 = 1.5 -> oil 10 * 1.5 = 15
    const byId = Object.fromEntries(v2.toObject().ingredients.map((i) => [String(i.foodItemId), i]));
    expect(byId[String(oil._id)].rawQuantity).toBe(15);
  });

  test('rebalancing within the core group without changing its total leaves sub ingredients exactly as submitted', async () => {
    const { v1, carrot, peas, beans, oil } = await makeMixedVegV1(); // total core = 300g

    const v2 = await createCustomVersion(v1._id, [
      { foodItemId: carrot._id, rawQuantity: 150, unit: 'g' }, // +50
      { foodItemId: peas._id, rawQuantity: 50, unit: 'g' }, // -50
      { foodItemId: beans._id, rawQuantity: 100, unit: 'g' }, // unchanged
      { foodItemId: oil._id, rawQuantity: 20, unit: 'g' }, // deliberate override
    ]);

    // total stays 300g -> ratio ~1 -> oil honored verbatim
    const byId = Object.fromEntries(v2.toObject().ingredients.map((i) => [String(i.foodItemId), i]));
    expect(byId[String(oil._id)].rawQuantity).toBe(20);
  });

  test('every ingredient in the version keeps its correct role after a multi-core recompute', async () => {
    const { v1, carrot, peas, beans, oil } = await makeMixedVegV1();

    const v2 = await createCustomVersion(v1._id, [
      { foodItemId: carrot._id, rawQuantity: 200, unit: 'g' },
      { foodItemId: peas._id, rawQuantity: 100, unit: 'g' },
      { foodItemId: beans._id, rawQuantity: 100, unit: 'g' },
      { foodItemId: oil._id, rawQuantity: 10, unit: 'g' },
    ]);

    const byId = Object.fromEntries(v2.toObject().ingredients.map((i) => [String(i.foodItemId), i.role]));
    expect(byId[String(carrot._id)]).toBe('core');
    expect(byId[String(peas._id)]).toBe('core');
    expect(byId[String(beans._id)]).toBe('core');
    expect(byId[String(oil._id)]).toBe('sub');
  });
});

describe('createVersionFromSnapshot - role, no aggregate-weight recompute', () => {
  async function makeOriginalV1() {
    const flour = await FoodItem.create({ name: 'Whole Wheat Flour', normalizedName: 'whole wheat flour', nutritionPer100g: { calories: 340, protein: 12, carbs: 70, fats: 2, fiber: 11 } });
    const water = await FoodItem.create({ name: 'Water', normalizedName: 'water', nutritionPer100g: { calories: 0, protein: 0, carbs: 0, fats: 0, fiber: 0 } });
    const v1 = await RecipeVersion.create({
      name: 'Chapati',
      parentRecipeId: new mongoose.Types.ObjectId(),
      versionNumber: 1,
      ingredients: [
        { foodItemId: flour._id, rawQuantity: 100, unit: 'g', role: 'core' },
        { foodItemId: water._id, rawQuantity: 60, unit: 'g', role: 'sub' },
      ],
      status: 'Active',
    });
    return { v1, flour, water };
  }

  test('role from the snapshot is preserved when it already has a core ingredient', async () => {
    const { v1 } = await makeOriginalV1();

    const v2 = await createVersionFromSnapshot(v1._id, {
      name: 'Chapati',
      ingredients: [
        { name: 'Whole Wheat Flour', quantity: 150, unit: 'g', category: 'Carbohydrate', role: 'core' },
        { name: 'Water', quantity: 90, unit: 'g', category: 'Other', role: 'sub' },
      ],
    });

    const byName = {};
    for (const i of v2.toObject().ingredients) {
      const foodItem = await FoodItem.findById(i.foodItemId);
      byName[foodItem.name] = i.role;
    }
    expect(byName['Whole Wheat Flour']).toBe('core');
    expect(byName['Water']).toBe('sub');
  });

  test('a zero-core snapshot (e.g. from a caller that never set role) is corrected by the category-priority heuristic', async () => {
    const { v1 } = await makeOriginalV1();

    const v2 = await createVersionFromSnapshot(v1._id, {
      name: 'Chapati',
      ingredients: [
        { name: 'Whole Wheat Flour', quantity: 150, unit: 'g', category: 'Carbohydrate' }, // no role at all
        { name: 'Water', quantity: 90, unit: 'g', category: 'Other' },
      ],
    });

    const byName = {};
    for (const i of v2.toObject().ingredients) {
      const foodItem = await FoodItem.findById(i.foodItemId);
      byName[foodItem.name] = i.role;
    }
    expect(byName['Whole Wheat Flour']).toBe('core'); // Carbohydrate outranks Other
    expect(byName['Water']).toBe('sub');
  });

  test('does not attempt an aggregate-weight recompute - every submitted quantity is used exactly as given', async () => {
    const { v1 } = await makeOriginalV1();

    // Flour more than doubled, Water barely changed - if this function ran
    // createCustomVersion's recompute, Water would be forced to scale with
    // Flour. It should not - this is a full snapshot replacement.
    const v2 = await createVersionFromSnapshot(v1._id, {
      name: 'Chapati',
      ingredients: [
        { name: 'Whole Wheat Flour', quantity: 250, unit: 'g', category: 'Carbohydrate', role: 'core' },
        { name: 'Water', quantity: 65, unit: 'g', category: 'Other', role: 'sub' },
      ],
    });

    const byName = {};
    for (const i of v2.toObject().ingredients) {
      const foodItem = await FoodItem.findById(i.foodItemId);
      byName[foodItem.name] = i.rawQuantity;
    }
    expect(byName['Whole Wheat Flour']).toBe(250);
    expect(byName['Water']).toBe(65); // exactly as submitted, not scaled to ~162.5
  });
});

describe('POST .../create-custom-version (HTTP) - core/sub recompute end to end', () => {
  const auth = (req) => req.set('Authorization', 'Bearer core-scaling-http-token');

  async function setupPlanItem(recipeIngredients) {
    const dietician = await createDietician();
    const patient = await createPatient();
    const recipe = await Recipe.create({
      dieticianId: dietician._id,
      name: 'Test Recipe',
      servingTime: 'Lunch',
      ingredients: recipeIngredients,
    });
    await new Promise((resolve) => setTimeout(resolve, 60)); // let the post-save V1 sync hook land
    const v1 = await RecipeVersion.findOne({ parentRecipeId: recipe._id, versionNumber: 1 });

    const dietPlan = await DietPlan.create({ patientId: patient._id, dieticianId: dietician._id, dataModel: 'plan-item', workflowStatus: 'menu_generated' });
    const dayPlan = await DayPlan.create({ dietPlanId: dietPlan._id, patientId: patient._id, week: 1, dayGroup: 'Monday' });
    const mealSlot = await MealSlotPlan.create({ dayPlanId: dayPlan._id, servingTime: 'Lunch' });
    const planItem = await PlanItem.create({ mealSlotId: mealSlot._id, recipeVersionId: v1._id, calculatedNutrition: v1.nutritionPerServing });

    registerTestToken('core-scaling-http-token', dietician._id);
    return { patient, dietPlan, planItem, v1 };
  }

  test('single-core recipe (Chapati-style): doubling the core ingredient over the real route doubles the sub ingredients', async () => {
    const flour = await FoodItem.create({ name: 'Whole Wheat Flour', normalizedName: 'whole wheat flour', nutritionPer100g: { calories: 340, protein: 12, carbs: 70, fats: 2, fiber: 11 } });
    const water = await FoodItem.create({ name: 'Water', normalizedName: 'water', nutritionPer100g: { calories: 0, protein: 0, carbs: 0, fats: 0, fiber: 0 } });
    const { patient, dietPlan, planItem, v1 } = await setupPlanItem([
      { name: 'Whole Wheat Flour', quantity: 100, unit: 'g', role: 'core' },
      { name: 'Water', quantity: 60, unit: 'g', role: 'sub' },
    ]);

    const res = await auth(
      request(app).post(`/api/dietician/patients/${patient._id}/diet-plans/${dietPlan._id}/create-custom-version`)
    ).send({
      planItemId: planItem._id.toString(),
      ingredients: [
        { foodItemId: flour._id.toString(), rawQuantity: 200, unit: 'g' },
        { foodItemId: water._id.toString(), rawQuantity: 1, unit: 'g' }, // attempted override
      ],
    });

    expect(res.status).toBe(200);
    const waterEntry = res.body.data.recipeVersion.ingredients.find((i) => i.foodItemId === String(water._id));
    expect(waterEntry.rawQuantity).toBe(120); // 60 * 2, not the submitted 1
  });

  test('multi-core recipe (Mixed Vegetable-style) over the real route: growing the total core weight scales the sub ingredient', async () => {
    const carrot = await FoodItem.create({ name: 'Carrot', normalizedName: 'carrot', nutritionPer100g: { calories: 41, protein: 0.9, carbs: 10, fats: 0.2, fiber: 2.8 } });
    const peas = await FoodItem.create({ name: 'Peas', normalizedName: 'peas', nutritionPer100g: { calories: 81, protein: 5, carbs: 14, fats: 0.4, fiber: 5 } });
    const oil = await FoodItem.create({ name: 'Oil', normalizedName: 'oil', nutritionPer100g: { calories: 884, protein: 0, carbs: 0, fats: 100, fiber: 0 } });
    const { patient, dietPlan, planItem } = await setupPlanItem([
      { name: 'Carrot', quantity: 100, unit: 'g', role: 'core' },
      { name: 'Peas', quantity: 100, unit: 'g', role: 'core' },
      { name: 'Oil', quantity: 10, unit: 'g', role: 'sub' },
    ]);

    const res = await auth(
      request(app).post(`/api/dietician/patients/${patient._id}/diet-plans/${dietPlan._id}/create-custom-version`)
    ).send({
      planItemId: planItem._id.toString(),
      ingredients: [
        { foodItemId: carrot._id.toString(), rawQuantity: 300, unit: 'g' }, // 100 -> 300 (total 200g -> 400g, 2x)
        { foodItemId: peas._id.toString(), rawQuantity: 100, unit: 'g' },
        { foodItemId: oil._id.toString(), rawQuantity: 1, unit: 'g' }, // attempted override
      ],
    });

    expect(res.status).toBe(200);
    const oilEntry = res.body.data.recipeVersion.ingredients.find((i) => i.foodItemId === String(oil._id));
    expect(oilEntry.rawQuantity).toBe(20); // 10 * 2, not the submitted 1
  });
});
