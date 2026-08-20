/**
 * The explicit user-required integration-flow test: a full Step 1->5 walk
 * via real HTTP requests, proving the V1->V2 versioning contract end to
 * end - not just each piece in isolation (that's what
 * tests/planItemCleverEndpoints.test.js already covers).
 */

const { connectTestDb, disconnectTestDb, clearTestDb } = require('./helpers/testDb');

jest.mock('../utils/supabaseAuth');
const { registerTestToken, clearTestTokens } = require('../utils/supabaseAuth');

let request;
let app;
let createPatient;
let createDietician;
let Recipe;
let FoodItem;
let RecipeVersion;
let DietPlan;
let PlanItem;

beforeAll(async () => {
  await connectTestDb();
  request = require('supertest');
  app = require('../config/createApp')();
  ({ createPatient, createDietician } = require('./helpers/factories'));
  ({ Recipe, FoodItem, RecipeVersion, DietPlan, PlanItem } = require('../models'));
});

afterEach(async () => {
  clearTestTokens();
  await clearTestDb();
});

afterAll(async () => {
  await disconnectTestDb();
});

const auth = (req) => req.set('Authorization', 'Bearer dietician-token');

test('Step 1 (targets) -> Step 2 (generate, all V1) -> Step 3 (edit one item to V2) -> Step 5 (finalize view shows V2 for the edited item, V1 elsewhere)', async () => {
  const dietician = await createDietician();
  const patient = await createPatient();
  registerTestToken('dietician-token', dietician._id);

  const oats = await FoodItem.create({ name: 'Oats', normalizedName: 'oats', nutritionPer100g: { calories: 389, protein: 17, carbs: 66, fats: 7, fiber: 10 } });
  for (const servingTime of ['Morning Drink', 'Breakfast', 'Brunch', 'Lunch', 'Evening Snack', 'Dinner', 'Night Drink']) {
    await Recipe.create({
      dieticianId: dietician._id,
      name: `${servingTime} Dish`,
      servingTime,
      components: [{ label: `${servingTime} Dish`, quantity: 100, unit: 'g' }],
      ingredients: [{ name: 'Oats', quantity: 100, unit: 'g' }],
      nutrition: { calories: 300, protein: 10, carbs: 30, fats: 5, fiber: 3 },
    });
  }
  await new Promise((resolve) => setTimeout(resolve, 150)); // let all 7 post-save V1 syncs land

  // Step 1: targets (a real request would go through a Targets step endpoint
  // that isn't part of this v4.0 slice yet - simulate by writing
  // targetProfile/calorieStrategy directly, matching how the old wizard's
  // Step 1 already persists targets before Step 2 exists).
  const dietPlan = await DietPlan.create({
    patientId: patient._id,
    dieticianId: dietician._id,
    dataModel: 'plan-item',
    workflowStatus: 'targets_set',
    calorieStrategy: { calorieBudget: 2000 },
  });

  // Step 2: generate-menu - every PlanItem should point at a versionNumber:1.
  const genRes = await auth(
    request(app).post(`/api/dietician/patients/${patient._id}/diet-plans/${dietPlan._id}/generate-menu`)
  ).send({ weekNumbers: [1] });
  expect(genRes.status).toBe(200);
  expect(genRes.body.data.workflowStatus).toBe('menu_generated');

  const afterGenerate = await DietPlan.findById(dietPlan._id);
  expect(afterGenerate.workflowStatus).toBe('menu_generated');

  const planItemsAfterGenerate = await PlanItem.find({});
  expect(planItemsAfterGenerate.length).toBeGreaterThan(0);
  for (const item of planItemsAfterGenerate) {
    const version = await RecipeVersion.findById(item.recipeVersionId);
    expect(version.versionNumber).toBe(1);
  }

  // Step 3: edit ONE item's ingredients - only that PlanItem should move to
  // a versionNumber:2, every sibling stays on versionNumber:1.
  const editedItem = planItemsAfterGenerate[0];
  const editedOriginalVersionId = String(editedItem.recipeVersionId);
  const otherItemIds = planItemsAfterGenerate.slice(1).map((item) => String(item._id));

  const editRes = await auth(
    request(app).post(`/api/dietician/patients/${patient._id}/diet-plans/${dietPlan._id}/create-custom-version`)
  ).send({ planItemId: String(editedItem._id), ingredients: [{ foodItemId: String(oats._id), rawQuantity: 250, unit: 'g' }] });
  expect(editRes.status).toBe(200);
  expect(editRes.body.data.recipeVersion.versionNumber).toBe(2);

  const afterEdit = await DietPlan.findById(dietPlan._id);
  expect(afterEdit.workflowStatus).toBe('portions_refined');

  const editedItemReloaded = await PlanItem.findById(editedItem._id);
  expect(String(editedItemReloaded.recipeVersionId)).not.toBe(editedOriginalVersionId);
  const editedVersion = await RecipeVersion.findById(editedItemReloaded.recipeVersionId);
  expect(editedVersion.versionNumber).toBe(2);
  expect(editedVersion.ingredients[0].rawQuantity).toBe(250);

  for (const otherId of otherItemIds) {
    const otherItem = await PlanItem.findById(otherId);
    const otherVersion = await RecipeVersion.findById(otherItem.recipeVersionId);
    expect(otherVersion.versionNumber).toBe(1); // untouched
  }

  // The original V1 the edited item used to point at is byte-for-byte unchanged.
  const originalV1Reloaded = await RecipeVersion.findById(editedOriginalVersionId);
  expect(originalV1Reloaded.ingredients[0].rawQuantity).toBe(100);

  // Step 5: finalize view returns V2 for the edited item, V1 for the rest.
  const planItemsRes = await auth(
    request(app).get(`/api/dietician/patients/${patient._id}/diet-plans/${dietPlan._id}/weeks/1/plan-items`)
  );
  expect(planItemsRes.status).toBe(200);

  const allReturnedItems = planItemsRes.body.data.days.flatMap((day) => day.meals.flatMap((meal) => meal.items));
  const returnedEditedItem = allReturnedItems.find((item) => item._id === String(editedItem._id));
  expect(returnedEditedItem.recipeVersion.versionNumber).toBe(2);
  expect(returnedEditedItem.recipeVersion.ingredients[0].rawQuantity).toBe(250);

  const returnedOtherItems = allReturnedItems.filter((item) => item._id !== String(editedItem._id));
  expect(returnedOtherItems.length).toBeGreaterThan(0);
  for (const item of returnedOtherItems) {
    expect(item.recipeVersion.versionNumber).toBe(1);
  }

  // Finalize.
  const finalizeRes = await auth(
    request(app).post(`/api/dietician/patients/${patient._id}/diet-plans/${dietPlan._id}/finalize-plan-item-week`)
  ).send({});
  expect(finalizeRes.status).toBe(200);
  expect(finalizeRes.body.data.workflowStatus).toBe('finalized');
});
