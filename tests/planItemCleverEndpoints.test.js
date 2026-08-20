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
  return FoodItem.create({ name, normalizedName: name.toLowerCase(), nutritionPer100g: { calories, protein: 10, carbs: 30, fats: 5, fiber: 3 } });
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

  const dietPlan = await DietPlan.create({ patientId: patient._id, dieticianId: dietician._id, dataModel: 'plan-item', workflowStatus: 'menu_generated' });
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
});

describe('POST .../finalize-plan-item-week', () => {
  test('sets workflowStatus to finalized', async () => {
    const { patient, dietPlan } = await setup();
    const res = await auth(
      request(app).post(`/api/dietician/patients/${patient._id}/diet-plans/${dietPlan._id}/finalize-plan-item-week`)
    ).send({});
    expect(res.status).toBe(200);
    expect(res.body.data.workflowStatus).toBe('finalized');
  });
});
