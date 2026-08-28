/**
 * v4.0 API endpoints (routes/dietician.js's "Ingredient-Level Portioning +
 * Recipe Versioning" block, controllers/dietician/planItemController.js) -
 * exercised end-to-end via supertest, mirroring
 * tests/dietPlanCleverEndpoints.test.js's setup convention.
 */

const { connectTestDb, disconnectTestDb, clearTestDb } = require('./helpers/testDb');

jest.mock('../utils/supabaseAuth');
const { registerTestToken, clearTestTokens } = require('../utils/supabaseAuth');

let request;
let app;
let mongoose;
let createPatient;
let createDietician;
let Recipe;
let FoodItem;
let RecipeVersion;
let DietPlan;
let DayPlan;
let MealSlotPlan;
let PlanItem;

beforeAll(async () => {
  await connectTestDb();
  request = require('supertest');
  app = require('../config/createApp')();
  mongoose = require('mongoose');
  ({ createPatient, createDietician } = require('./helpers/factories'));
  ({ Recipe, FoodItem, RecipeVersion, DietPlan, DayPlan, MealSlotPlan, PlanItem } = require('../models'));
});

afterEach(async () => {
  clearTestTokens();
  await clearTestDb();
});

afterAll(async () => {
  await disconnectTestDb();
});

const auth = (req) => req.set('Authorization', 'Bearer dietician-token');

async function makeFoodItem(name, calories) {
  // Upsert, not create - a real-world FoodItem is global, and some tests
  // call setup() more than once (e.g. to get two independent diet plans),
  // which would otherwise collide on the unique normalizedName index.
  return FoodItem.findOneAndUpdate(
    { normalizedName: name.toLowerCase() },
    { $setOnInsert: { name, normalizedName: name.toLowerCase(), nutritionPer100g: { calories, protein: 10, carbs: 30, fats: 5, fiber: 3 } } },
    { upsert: true, returnDocument: 'after' }
  );
}

async function makeResolvedRecipe({ dieticianId, name, servingTime, foodItem }) {
  const recipe = await Recipe.create({
    dieticianId,
    name,
    servingTime,
    components: [{ label: name, quantity: 100, unit: 'g' }],
    ingredients: [{ name: foodItem.name, quantity: 100, unit: 'g' }],
    nutrition: { calories: 300, protein: 10, carbs: 30, fats: 5, fiber: 3 },
  });
  await new Promise((resolve) => setTimeout(resolve, 60)); // let the post-save V1 sync hook land
  const v1 = await RecipeVersion.findOne({ parentRecipeId: recipe._id, versionNumber: 1 });
  return { recipe, v1 };
}

async function setup() {
  const dietician = await createDietician();
  const patient = await createPatient();
  const oats = await makeFoodItem('Oats', 389);
  const { recipe, v1 } = await makeResolvedRecipe({ dieticianId: dietician._id, name: 'Oats Porridge', servingTime: 'Breakfast', foodItem: oats });

  const dietPlan = await DietPlan.create({
    patientId: patient._id,
    dieticianId: dietician._id,
    dataModel: 'plan-item',
    workflowStatus: 'menu_generated',
    // Matches the one PlanItem's actual calories exactly, so tests in this
    // file that don't care about activation tolerance (everything except
    // the finalize-plan-item-week describe block) aren't affected by it.
    calorieStrategy: { calorieBudget: v1.nutritionPerServing.calories },
  });
  const dayPlan = await DayPlan.create({ dietPlanId: dietPlan._id, patientId: patient._id, week: 1, dayGroup: 'Monday' });
  const mealSlot = await MealSlotPlan.create({ dayPlanId: dayPlan._id, servingTime: 'Breakfast' });
  const planItem = await PlanItem.create({ mealSlotId: mealSlot._id, recipeVersionId: v1._id, calculatedNutrition: v1.nutritionPerServing });

  registerTestToken('dietician-token', dietician._id);
  return { dietician, patient, oats, recipe, v1, dietPlan, dayPlan, mealSlot, planItem };
}

describe('POST .../generate-menu', () => {
  test('fills every day-group/servingTime slot for the requested week and sets workflowStatus', async () => {
    const dietician = await createDietician();
    const patient = await createPatient();
    const oats = await makeFoodItem('Oats', 389);
    for (const servingTime of ['Morning Drink', 'Breakfast', 'Brunch', 'Lunch', 'Evening Snack', 'Dinner', 'Night Drink']) {
      await makeResolvedRecipe({ dieticianId: dietician._id, name: `${servingTime} Dish`, servingTime, foodItem: oats });
    }
    const dietPlan = await DietPlan.create({ patientId: patient._id, dieticianId: dietician._id, dataModel: 'plan-item' });
    registerTestToken('dietician-token', dietician._id);

    const res = await auth(
      request(app).post(`/api/dietician/patients/${patient._id}/diet-plans/${dietPlan._id}/generate-menu`)
    ).send({ weekNumbers: [1] });

    expect(res.status).toBe(200);
    expect(res.body.data.unfillableSlots).toEqual([]);
    expect(res.body.data.workflowStatus).toBe('menu_generated');

    const saved = await DietPlan.findById(dietPlan._id);
    expect(saved.workflowStatus).toBe('menu_generated');
    const dayPlans = await DayPlan.find({ dietPlanId: dietPlan._id });
    expect(dayPlans).toHaveLength(4);
  });

  test('400s for a days-array plan', async () => {
    const dietician = await createDietician();
    const patient = await createPatient();
    const dietPlan = await DietPlan.create({ patientId: patient._id, dieticianId: dietician._id }); // default dataModel
    registerTestToken('dietician-token', dietician._id);

    const res = await auth(
      request(app).post(`/api/dietician/patients/${patient._id}/diet-plans/${dietPlan._id}/generate-menu`)
    ).send({});
    expect(res.status).toBe(400);
  });
});

describe('POST .../create-custom-version', () => {
  test('creates a new RecipeVersion and repoints the PlanItem, advancing workflowStatus', async () => {
    const { patient, dietPlan, planItem, oats } = await setup();

    const res = await auth(
      request(app).post(`/api/dietician/patients/${patient._id}/diet-plans/${dietPlan._id}/create-custom-version`)
    ).send({ planItemId: planItem._id.toString(), ingredients: [{ foodItemId: oats._id.toString(), rawQuantity: 200, unit: 'g' }] });

    expect(res.status).toBe(200);
    expect(res.body.data.recipeVersion.versionNumber).toBe(2);
    expect(res.body.data.planItem.recipeVersionId).toBe(res.body.data.recipeVersion._id);

    const savedPlan = await DietPlan.findById(dietPlan._id);
    expect(savedPlan.workflowStatus).toBe('portions_refined');
  });

  test('pins the plan item so a later auto-balance leaves its portion alone', async () => {
    const { patient, dietPlan, planItem, oats } = await setup();

    await auth(
      request(app).post(`/api/dietician/patients/${patient._id}/diet-plans/${dietPlan._id}/create-custom-version`)
    ).send({ planItemId: planItem._id.toString(), ingredients: [{ foodItemId: oats._id.toString(), rawQuantity: 200, unit: 'g' }] });

    const saved = await PlanItem.findById(planItem._id);
    expect(saved.pinned).toBe(true);
  });
});

describe('POST .../update-item-recipe-version', () => {
  test('resolves free-text ingredients to FoodItems, creates a new RecipeVersion under the same parentRecipeId, and repoints only this PlanItem', async () => {
    const { patient, dietPlan, planItem, recipe, oats } = await setup();

    const res = await auth(
      request(app).post(`/api/dietician/patients/${patient._id}/diet-plans/${dietPlan._id}/update-item-recipe-version`)
    ).send({
      planItemId: planItem._id.toString(),
      recipe: {
        name: 'Oats Porridge (AI-updated)',
        ingredients: [{ name: oats.name, quantity: 150, unit: 'g' }],
        cookingSteps: ['Cook oats in water.'],
      },
    });

    expect(res.status).toBe(200);
    expect(res.body.data.recipeVersion.versionNumber).toBe(2);
    expect(res.body.data.recipeVersion.parentRecipeId).toBe(recipe._id.toString());
    expect(res.body.data.planItem.recipeVersionId).toBe(res.body.data.recipeVersion._id);

    const savedPlan = await DietPlan.findById(dietPlan._id);
    expect(savedPlan.workflowStatus).toBe('portions_refined');

    const savedItem = await PlanItem.findById(planItem._id);
    expect(savedItem.pinned).toBe(true);
  });

  test('400s when no ingredient matches a known food item', async () => {
    const { patient, dietPlan, planItem } = await setup();

    const res = await auth(
      request(app).post(`/api/dietician/patients/${patient._id}/diet-plans/${dietPlan._id}/update-item-recipe-version`)
    ).send({
      planItemId: planItem._id.toString(),
      recipe: { name: 'Mystery Dish', ingredients: [{ name: 'Completely Unknown Ingredient', quantity: 50, unit: 'g' }] },
    });

    expect(res.status).toBe(400);
  });
});

describe('POST .../auto-balance', () => {
  test('scope:item scales the PlanItem\'s ingredients to hit targetCalories', async () => {
    const { patient, dietPlan, planItem, v1 } = await setup();

    const res = await auth(
      request(app).post(`/api/dietician/patients/${patient._id}/diet-plans/${dietPlan._id}/auto-balance`)
    ).send({ scope: 'item', planItemId: planItem._id.toString(), targetCalories: v1.nutritionPerServing.calories * 2 });

    expect(res.status).toBe(200);
    expect(res.body.data.recipeVersion.nutritionPerServing.calories).toBeCloseTo(v1.nutritionPerServing.calories * 2, 0);
  });

  test('rejects an unrecognized scope', async () => {
    const { patient, dietPlan } = await setup();
    const res = await auth(
      request(app).post(`/api/dietician/patients/${patient._id}/diet-plans/${dietPlan._id}/auto-balance`)
    ).send({ scope: 'planet' });
    expect(res.status).toBe(400);
  });
});

describe('GET .../weeks/:week/plan-items', () => {
  test('returns the joined day/meal/item structure', async () => {
    const { patient, dietPlan, recipe } = await setup();

    const res = await auth(
      request(app).get(`/api/dietician/patients/${patient._id}/diet-plans/${dietPlan._id}/weeks/1/plan-items`)
    );

    expect(res.status).toBe(200);
    const monday = res.body.data.days.find((d) => d.dayGroup === 'Monday');
    const breakfast = monday.meals.find((m) => m.servingTime === 'Breakfast');
    expect(breakfast.items).toHaveLength(1);
    expect(breakfast.items[0].recipeVersion.parentRecipeId).toBe(recipe._id.toString());
    expect(breakfast.items[0].recipeVersion.ingredients[0].foodItemName).toBe('Oats');
    expect(breakfast.items[0].recipeVersion.ingredients[0].nutritionPer100g.calories).toBe(389);
    // 'g' resolves trivially to 1 gram per unit.
    expect(breakfast.items[0].recipeVersion.ingredients[0].resolvedGramsPerUnit).toBe(1);
  });

  test('resolvedGramsPerUnit resolves a non-g unit via the FoodItem\'s own unitConversions', async () => {
    const { dietician, patient } = await setup();
    const chapati = await FoodItem.findOneAndUpdate(
      { normalizedName: 'chapati' },
      {
        $setOnInsert: {
          name: 'Chapati',
          normalizedName: 'chapati',
          nutritionPer100g: { calories: 260, protein: 7.5, carbs: 50, fats: 4, fiber: 4.5 },
          unitConversions: { piece: 40 },
        },
      },
      { upsert: true, returnDocument: 'after' }
    );
    const { v1 } = await makeResolvedRecipe({ dieticianId: dietician._id, name: 'Chapati Meal', servingTime: 'Lunch', foodItem: chapati });
    v1.ingredients = [{ foodItemId: chapati._id, rawQuantity: 2, unit: 'piece' }];
    await v1.save();
    const dietPlan = await DietPlan.create({ patientId: patient._id, dieticianId: dietician._id, dataModel: 'plan-item', workflowStatus: 'menu_generated' });
    const dayPlan = await DayPlan.create({ dietPlanId: dietPlan._id, patientId: patient._id, week: 1, dayGroup: 'Monday' });
    const mealSlot = await MealSlotPlan.create({ dayPlanId: dayPlan._id, servingTime: 'Lunch' });
    await PlanItem.create({ mealSlotId: mealSlot._id, recipeVersionId: v1._id, calculatedNutrition: v1.nutritionPerServing });

    const res = await auth(
      request(app).get(`/api/dietician/patients/${patient._id}/diet-plans/${dietPlan._id}/weeks/1/plan-items`)
    );

    const lunch = res.body.data.days.find((d) => d.dayGroup === 'Monday').meals.find((m) => m.servingTime === 'Lunch');
    expect(lunch.items[0].recipeVersion.ingredients[0].resolvedGramsPerUnit).toBe(40);
  });

  test('resolvedGramsPerUnit is null when the FoodItem has no conversion for the ingredient\'s unit', async () => {
    const { dietician, patient } = await setup();
    const almonds = await FoodItem.findOneAndUpdate(
      { normalizedName: 'almonds' },
      { $setOnInsert: { name: 'Almonds', normalizedName: 'almonds', nutritionPer100g: { calories: 579, protein: 21, carbs: 22, fats: 50, fiber: 12 } } },
      { upsert: true, returnDocument: 'after' }
    );
    const { v1 } = await makeResolvedRecipe({ dieticianId: dietician._id, name: 'Almond Snack', servingTime: 'Evening Snack', foodItem: almonds });
    v1.ingredients = [{ foodItemId: almonds._id, rawQuantity: 5, unit: 'nos' }];
    await v1.save();
    const dietPlan = await DietPlan.create({ patientId: patient._id, dieticianId: dietician._id, dataModel: 'plan-item', workflowStatus: 'menu_generated' });
    const dayPlan = await DayPlan.create({ dietPlanId: dietPlan._id, patientId: patient._id, week: 1, dayGroup: 'Monday' });
    const mealSlot = await MealSlotPlan.create({ dayPlanId: dayPlan._id, servingTime: 'Evening Snack' });
    await PlanItem.create({ mealSlotId: mealSlot._id, recipeVersionId: v1._id, calculatedNutrition: v1.nutritionPerServing });

    const res = await auth(
      request(app).get(`/api/dietician/patients/${patient._id}/diet-plans/${dietPlan._id}/weeks/1/plan-items`)
    );

    const snack = res.body.data.days.find((d) => d.dayGroup === 'Monday').meals.find((m) => m.servingTime === 'Evening Snack');
    expect(snack.items[0].recipeVersion.ingredients[0].resolvedGramsPerUnit).toBeNull();
  });
});

describe('POST .../swap-recipe-version', () => {
  test('repoints the PlanItem at a different recipe\'s V1', async () => {
    const { dietician, patient, dietPlan, planItem, oats } = await setup();
    const { recipe: newRecipe, v1: newV1 } = await makeResolvedRecipe({ dieticianId: dietician._id, name: 'Poha', servingTime: 'Breakfast', foodItem: oats });

    const res = await auth(
      request(app).post(`/api/dietician/patients/${patient._id}/diet-plans/${dietPlan._id}/swap-recipe-version`)
    ).send({ planItemId: planItem._id.toString(), newParentRecipeId: newRecipe._id.toString() });

    expect(res.status).toBe(200);
    expect(res.body.data.item.recipeVersionId).toBe(newV1._id.toString());
  });
});

describe('POST .../timeline-supplements', () => {
  test('creates a supplement and updating it again replaces fields, not duplicates', async () => {
    const { dietician, patient, dietPlan } = await setup();
    const supplement = await Recipe.create({ dieticianId: dietician._id, name: 'Multivitamin', servingTime: 'Breakfast', category: 'Supplements' });

    const body = { week: 1, dayGroup: 'Monday', servingTime: 'Breakfast', supplementRecipeId: supplement._id.toString(), timingAnchor: 'post' };
    await auth(request(app).post(`/api/dietician/patients/${patient._id}/diet-plans/${dietPlan._id}/timeline-supplements`)).send({ ...body, dosage: '1 tablet' });
    const res2 = await auth(request(app).post(`/api/dietician/patients/${patient._id}/diet-plans/${dietPlan._id}/timeline-supplements`)).send({ ...body, dosage: '2 tablets' });

    expect(res2.status).toBe(200);
    expect(res2.body.data.supplementItem.dosage).toBe('2 tablets');

    const { SupplementItem } = require('../models');
    const all = await SupplementItem.find({});
    expect(all).toHaveLength(1);
  });

  test('rejects an invalid timingAnchor', async () => {
    const { dietician, patient, dietPlan } = await setup();
    const supplement = await Recipe.create({ dieticianId: dietician._id, name: 'Multivitamin', servingTime: 'Breakfast', category: 'Supplements' });

    const res = await auth(
      request(app).post(`/api/dietician/patients/${patient._id}/diet-plans/${dietPlan._id}/timeline-supplements`)
    ).send({ week: 1, dayGroup: 'Monday', servingTime: 'Breakfast', supplementRecipeId: supplement._id.toString(), timingAnchor: 'sometime' });

    expect(res.status).toBe(400);
  });

  test('rejects a missing timingAnchor', async () => {
    const { dietician, patient, dietPlan } = await setup();
    const supplement = await Recipe.create({ dieticianId: dietician._id, name: 'Multivitamin', servingTime: 'Breakfast', category: 'Supplements' });

    const res = await auth(
      request(app).post(`/api/dietician/patients/${patient._id}/diet-plans/${dietPlan._id}/timeline-supplements`)
    ).send({ week: 1, dayGroup: 'Monday', servingTime: 'Breakfast', supplementRecipeId: supplement._id.toString() });

    expect(res.status).toBe(400);
  });
});

describe('POST .../finalize-plan-item-week', () => {
  test('sets workflowStatus to finalized when every day is within +/-5% of target', async () => {
    const { patient, dietPlan } = await setup();
    const res = await auth(
      request(app).post(`/api/dietician/patients/${patient._id}/diet-plans/${dietPlan._id}/finalize-plan-item-week`)
    ).send({});
    expect(res.status).toBe(200);
    expect(res.body.data.workflowStatus).toBe('finalized');
    expect(res.body.data.days[0].withinTolerance).toBe(true);
  });

  test('422s and does not finalize when a day is outside +/-5% of target', async () => {
    const { patient, dietPlan } = await setup();
    dietPlan.calorieStrategy = { calorieBudget: 100 }; // the one PlanItem is ~389 cal - way outside tolerance
    await dietPlan.save();

    const res = await auth(
      request(app).post(`/api/dietician/patients/${patient._id}/diet-plans/${dietPlan._id}/finalize-plan-item-week`)
    ).send({});
    expect(res.status).toBe(422);
    expect(res.body.data.days[0].withinTolerance).toBe(false);

    const reloaded = await DietPlan.findById(dietPlan._id);
    expect(reloaded.workflowStatus).not.toBe('finalized');
  });

  test('400s when the plan has no calorie target set', async () => {
    const { patient, dietPlan } = await setup();
    dietPlan.calorieStrategy = undefined;
    await dietPlan.save();

    const res = await auth(
      request(app).post(`/api/dietician/patients/${patient._id}/diet-plans/${dietPlan._id}/finalize-plan-item-week`)
    ).send({});
    expect(res.status).toBe(400);
  });

  test('promotes DietPlan.status Draft -> Finalized on success, required by dietPlanController.js::activateDietPlan', async () => {
    const { patient, dietPlan } = await setup();
    expect(dietPlan.status).toBe('Draft');

    const res = await auth(
      request(app).post(`/api/dietician/patients/${patient._id}/diet-plans/${dietPlan._id}/finalize-plan-item-week`)
    ).send({});
    expect(res.status).toBe(200);

    const reloaded = await DietPlan.findById(dietPlan._id);
    expect(reloaded.status).toBe('Finalized');
  });

  test('400s for a days-array plan and never touches its status', async () => {
    const dietician = await createDietician();
    const patient = await createPatient();
    const dietPlan = await DietPlan.create({ patientId: patient._id, dieticianId: dietician._id }); // default dataModel, status: 'Draft'
    registerTestToken('dietician-token', dietician._id);

    const res = await auth(
      request(app).post(`/api/dietician/patients/${patient._id}/diet-plans/${dietPlan._id}/finalize-plan-item-week`)
    ).send({});
    expect(res.status).toBe(400);

    const reloaded = await DietPlan.findById(dietPlan._id);
    expect(reloaded.status).toBe('Draft'); // untouched - loadPlanItemDietPlan rejects before the status-promotion logic ever runs
  });
});

describe('POST .../plan-items (add)', () => {
  test('adds a second item to a meal slot, pointing at the recipe\'s V1', async () => {
    const { dietician, patient, dietPlan, mealSlot, oats } = await setup();
    const { recipe: secondRecipe, v1: secondV1 } = await makeResolvedRecipe({ dieticianId: dietician._id, name: 'Poha', servingTime: 'Breakfast', foodItem: oats });

    const res = await auth(
      request(app).post(`/api/dietician/patients/${patient._id}/diet-plans/${dietPlan._id}/plan-items`)
    ).send({ mealSlotId: mealSlot._id.toString(), recipeId: secondRecipe._id.toString() });

    expect(res.status).toBe(201);
    expect(res.body.data.planItem.recipeVersionId).toBe(secondV1._id.toString());

    const itemsInSlot = await PlanItem.find({ mealSlotId: mealSlot._id });
    expect(itemsInSlot).toHaveLength(2); // the original from setup() + this new one
  });

  test('404s for a recipe with no Active V1', async () => {
    const { patient, dietPlan, mealSlot } = await setup();
    const noVersionRecipeId = new mongoose.Types.ObjectId();

    const res = await auth(
      request(app).post(`/api/dietician/patients/${patient._id}/diet-plans/${dietPlan._id}/plan-items`)
    ).send({ mealSlotId: mealSlot._id.toString(), recipeId: noVersionRecipeId.toString() });

    expect(res.status).toBe(404);
  });

  test('404s for a mealSlotId belonging to a different diet plan', async () => {
    const { patient, dietPlan, recipe } = await setup();
    const other = await setup();

    const res = await auth(
      request(app).post(`/api/dietician/patients/${patient._id}/diet-plans/${dietPlan._id}/plan-items`)
    ).send({ mealSlotId: other.mealSlot._id.toString(), recipeId: recipe._id.toString() });

    expect(res.status).toBe(404);
  });
});

describe('DELETE .../plan-items/:planItemId (remove)', () => {
  test('removes the item entirely, no replacement', async () => {
    const { patient, dietPlan, planItem } = await setup();

    const res = await auth(
      request(app).delete(`/api/dietician/patients/${patient._id}/diet-plans/${dietPlan._id}/plan-items/${planItem._id}`)
    );

    expect(res.status).toBe(200);
    expect(await PlanItem.findById(planItem._id)).toBeNull();
  });

  test('refuses to remove a locked item', async () => {
    const { patient, dietPlan, planItem } = await setup();
    planItem.locked = true;
    await planItem.save();

    const res = await auth(
      request(app).delete(`/api/dietician/patients/${patient._id}/diet-plans/${dietPlan._id}/plan-items/${planItem._id}`)
    );

    expect(res.status).toBe(409);
    expect(await PlanItem.findById(planItem._id)).not.toBeNull();
  });

  test('404s for a planItemId belonging to a different diet plan', async () => {
    const { patient, dietPlan } = await setup();
    const other = await setup();

    const res = await auth(
      request(app).delete(`/api/dietician/patients/${patient._id}/diet-plans/${dietPlan._id}/plan-items/${other.planItem._id}`)
    );

    expect(res.status).toBe(404);
    expect(await PlanItem.findById(other.planItem._id)).not.toBeNull(); // untouched
  });
});

describe('PATCH .../plan-items/:planItemId (set pinned)', () => {
  test('unpinning clears the flag without changing the portion', async () => {
    const { patient, dietPlan, planItem } = await setup();
    planItem.pinned = true;
    await planItem.save();
    const originalVersionId = String(planItem.recipeVersionId);

    const res = await auth(
      request(app).patch(`/api/dietician/patients/${patient._id}/diet-plans/${dietPlan._id}/plan-items/${planItem._id}`)
    ).send({ pinned: false });

    expect(res.status).toBe(200);
    const saved = await PlanItem.findById(planItem._id);
    expect(saved.pinned).toBe(false);
    expect(String(saved.recipeVersionId)).toBe(originalVersionId);
  });

  test('400s when pinned is not a boolean', async () => {
    const { patient, dietPlan, planItem } = await setup();
    const res = await auth(
      request(app).patch(`/api/dietician/patients/${patient._id}/diet-plans/${dietPlan._id}/plan-items/${planItem._id}`)
    ).send({ pinned: 'yes' });
    expect(res.status).toBe(400);
  });

  test('404s for a planItemId belonging to a different diet plan', async () => {
    const { patient, dietPlan } = await setup();
    const other = await setup();
    const res = await auth(
      request(app).patch(`/api/dietician/patients/${patient._id}/diet-plans/${dietPlan._id}/plan-items/${other.planItem._id}`)
    ).send({ pinned: true });
    expect(res.status).toBe(404);
  });
});

describe('POST .../auto-balance skips pinned items', () => {
  test('scope:day leaves a pinned item untouched and rebalances the rest', async () => {
    const { dietician, patient, dietPlan, dayPlan, mealSlot, planItem, oats } = await setup();
    // Second item in the same day so there's something to rebalance.
    const { v1: secondV1 } = await makeResolvedRecipe({ dieticianId: dietician._id, name: 'Poha', servingTime: 'Lunch', foodItem: oats });
    const lunchSlot = await MealSlotPlan.create({ dayPlanId: dayPlan._id, servingTime: 'Lunch' });
    const secondItem = await PlanItem.create({ mealSlotId: lunchSlot._id, recipeVersionId: secondV1._id, calculatedNutrition: secondV1.nutritionPerServing });

    planItem.pinned = true;
    await planItem.save();
    const pinnedVersionId = String(planItem.recipeVersionId);

    const res = await auth(
      request(app).post(`/api/dietician/patients/${patient._id}/diet-plans/${dietPlan._id}/auto-balance`)
    ).send({ scope: 'day', dayPlanId: dayPlan._id.toString(), targetDailyCalories: 2000 });

    expect(res.status).toBe(200);
    const pinnedAfter = await PlanItem.findById(planItem._id);
    expect(String(pinnedAfter.recipeVersionId)).toBe(pinnedVersionId);
    const secondAfter = await PlanItem.findById(secondItem._id);
    expect(String(secondAfter.recipeVersionId)).not.toBe(String(secondV1._id));
  });
});
