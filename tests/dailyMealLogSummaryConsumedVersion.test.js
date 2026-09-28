/**
 * Regression test for the "fix-plan-item-consumed-calories-recipe-version"
 * OpenSpec change: a logged meal's consumed calories/macros for a
 * 'plan-item' plan must be computed from the specific prescribed
 * RecipeVersion, not the base Recipe's own (often stale) nutrition field.
 *
 * Caught live: a patient who logged exactly her prescribed 1-serving
 * portions showed totalConsumedCalories ~46% over her plan, because
 * computeDailyMealLogSummary's liveCaloriesConsumed() resolved logged
 * meals (which only ever carry the base Recipe._id - submitMealLog strips
 * the version key) against the base Recipe.nutrition field instead of the
 * RecipeVersion.nutritionPerServing actually assigned on her plan.
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
let DayPlan;
let MealSlotPlan;
let PlanItem;
let versionedRecipeKey;
let baseRecipeIdFromKey;
let resolveDayGroupForDate;

beforeAll(async () => {
  await connectTestDb();
  request = require('supertest');
  app = require('../config/createApp')();
  ({ createPatient, createDietician } = require('./helpers/factories'));
  ({ Recipe, FoodItem, RecipeVersion, DietPlan, DayPlan, MealSlotPlan, PlanItem } = require('../models'));
  ({ versionedRecipeKey, baseRecipeIdFromKey } = require('../utils/dietPlanReadDispatch'));
  ({ resolveDayGroupForDate } = require('../utils/dayGroups'));
});

afterEach(async () => {
  clearTestTokens();
  await clearTestDb();
});

afterAll(async () => {
  await disconnectTestDb();
});

// Sets up a plan-item DietPlan, active today, with one recipe on today's
// dayGroup at Breakfast - the recipe's base `nutrition` is deliberately
// wrong (999 across the board) so any test reading it instead of the real
// per-ingredient RecipeVersion figure is caught immediately.
async function setupTodaysPlanItemPlan() {
  const dietician = await createDietician();
  const patient = await createPatient();

  await FoodItem.create({
    name: 'Oats',
    normalizedName: 'oats',
    nutritionPer100g: { calories: 389, protein: 17, carbs: 66, fats: 7, fiber: 10 },
  });
  const recipe = await Recipe.create({
    dieticianId: dietician._id,
    name: 'Oats Porridge',
    servingTime: 'Breakfast',
    components: [{ label: 'Oats Porridge', quantity: 100, unit: 'g' }],
    ingredients: [{ name: 'Oats', quantity: 100, unit: 'g' }],
    // Deliberately wrong - must never be what consumed calories/macros use.
    nutrition: { calories: 999, protein: 999, carbs: 999, fats: 999, fiber: 999 },
  });
  await new Promise((resolve) => setTimeout(resolve, 300)); // let the post-save V1 sync hook land
  const v1 = await RecipeVersion.findOne({ parentRecipeId: recipe._id, versionNumber: 1 });

  const today = new Date();
  const dayGroup = resolveDayGroupForDate(today);
  const dietPlan = await DietPlan.create({
    patientId: patient._id,
    dieticianId: dietician._id,
    status: 'Active',
    dataModel: 'plan-item',
    activationDate: today,
    weekSchedule: [{ week: 1, startDate: new Date(today.getTime() - 86400000), endDate: new Date(today.getTime() + 6 * 86400000) }],
  });
  const dayPlan = await DayPlan.create({ dietPlanId: dietPlan._id, patientId: patient._id, week: 1, dayGroup });
  const mealSlot = await MealSlotPlan.create({ dayPlanId: dayPlan._id, servingTime: 'Breakfast' });
  await PlanItem.create({ mealSlotId: mealSlot._id, recipeVersionId: v1._id, calculatedNutrition: v1.nutritionPerServing });

  registerTestToken('patient-token', patient._id);
  return { patient, recipe, v1, today };
}

test('consumed calories/macros for a logged plan-item meal use the prescribed RecipeVersion, not the base Recipe', async () => {
  const { recipe, v1, today } = await setupTodaysPlanItemPlan();
  const versionedId = versionedRecipeKey(recipe._id.toString(), 1);

  const logRes = await request(app)
    .post('/api/patient/meal-log')
    .set('Authorization', 'Bearer patient-token')
    .send({
      date: today.toISOString(),
      items: [{ servingTime: 'Breakfast', recipeId: versionedId, servings: 1, caloriesConsumed: v1.nutritionPerServing.calories }],
    });
  expect(logRes.status).toBe(200);

  const statsRes = await request(app)
    .get(`/api/patient/meal-log/today-stats?date=${today.toISOString().slice(0, 10)}`)
    .set('Authorization', 'Bearer patient-token');
  expect(statsRes.status).toBe(200);

  const { summary, macros } = statsRes.body.data;
  // The real per-ingredient figure (100g oats @ 389kcal/100g), not the base
  // Recipe's bogus authored 999.
  expect(summary.totalConsumedCalories).toBeCloseTo(389, 0);
  expect(macros.consumed.protein).toBeCloseTo(17, 0);
  expect(macros.consumed.carbs).toBeCloseTo(66, 0);
  expect(macros.consumed.fats).toBeCloseTo(7, 0);
  expect(macros.consumed.fiber).toBeCloseTo(10, 0);
});

test('a meal logged off-plan (not on today\'s plan) still falls back to the base Recipe nutrition', async () => {
  const { patient, today } = await setupTodaysPlanItemPlan();

  const offPlanRecipe = await Recipe.create({
    dieticianId: (await DietPlan.findOne({ patientId: patient._id })).dieticianId,
    name: 'Off-Plan Snack',
    servingTime: 'Evening Snack',
    nutrition: { calories: 250, protein: 5, carbs: 30, fats: 8, fiber: 2 },
  });

  const logRes = await request(app)
    .post('/api/patient/meal-log')
    .set('Authorization', 'Bearer patient-token')
    .send({
      date: today.toISOString(),
      items: [{ servingTime: 'Evening Snack', recipeId: offPlanRecipe._id.toString(), servings: 1, caloriesConsumed: 250 }],
    });
  expect(logRes.status).toBe(200);

  const statsRes = await request(app)
    .get(`/api/patient/meal-log/today-stats?date=${today.toISOString().slice(0, 10)}`)
    .set('Authorization', 'Bearer patient-token');
  expect(statsRes.status).toBe(200);

  // Off-plan log has no prescribed version to prefer - falls back to the
  // base Recipe's own (here, correct) nutrition, unchanged from before this
  // fix. Total is the on-plan Breakfast item (not logged in this test) at 0
  // plus this off-plan snack's 250.
  expect(statsRes.body.data.summary.totalConsumedCalories).toBeCloseTo(250, 0);
});
