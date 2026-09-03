/**
 * Meal logging for a 'plan-item' (v4.0) DietPlan, end-to-end through the
 * real endpoints:
 *   GET  /api/patient/meal-log/screen-data  (dietController.getMealLogScreenData)
 *   POST /api/patient/meal-log              (dietController.submitMealLog)
 *
 * Guards the two bugs a plan-item patient hit because only /diet/active was
 * ever made dataModel-aware:
 *   1. screen-data called getFinalizedWeeks directly -> [] for a plan-item
 *      plan -> every Log Meal tab showed "No meals".
 *   2. the app can only echo back the *versioned* recipe key ("<id>::v2")
 *      /diet/active handed it -> submitMealLog's ObjectId.isValid rejected
 *      it with "Invalid item in items array" ("Could not log this meal").
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
let MealLog;
let versionedRecipeKey;

beforeAll(async () => {
  await connectTestDb();
  request = require('supertest');
  app = require('../config/createApp')();
  ({ createPatient, createDietician } = require('./helpers/factories'));
  ({ Recipe, FoodItem, RecipeVersion, DietPlan, DayPlan, MealSlotPlan, PlanItem, MealLog } = require('../models'));
  ({ versionedRecipeKey } = require('../utils/dietPlanReadDispatch'));
});

afterEach(async () => {
  clearTestTokens();
  await clearTestDb();
});

afterAll(async () => {
  await disconnectTestDb();
});

const DAY_GROUPS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday'];

async function seedPlanItemPlan() {
  const dietician = await createDietician();
  const patient = await createPatient();

  await FoodItem.create({
    name: 'Oats',
    normalizedName: 'oats',
    nutritionPer100g: { calories: 389, protein: 17, carbs: 66, fats: 7, fiber: 10 },
  });
  // Base recipe with a deliberately non-1 servingSize.quantity and bogus
  // authored nutrition - both must be ignored in favour of the V1 version.
  const recipe = await Recipe.create({
    dieticianId: dietician._id,
    name: 'Oats Porridge',
    servingTime: 'Breakfast',
    servingSize: { quantity: 250, unit: 'g' },
    components: [{ label: 'Oats Porridge', quantity: 100, unit: 'g' }],
    ingredients: [{ name: 'Oats', quantity: 100, unit: 'g' }],
    nutrition: { calories: 999, protein: 999, carbs: 999, fats: 999, fiber: 999 },
  });
  // the post-save V1 sync hook is async and fire-and-forget - poll for it
  let v1 = null;
  for (let i = 0; i < 40 && !v1; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    v1 = await RecipeVersion.findOne({ parentRecipeId: recipe._id, versionNumber: 1 });
  }
  if (!v1) throw new Error('V1 RecipeVersion never synced for the seeded recipe');

  const activationDate = new Date();
  const dietPlan = await DietPlan.create({
    patientId: patient._id,
    dieticianId: dietician._id,
    status: 'Active',
    dataModel: 'plan-item',
    activationDate,
    weekSchedule: [
      { week: 1, startDate: activationDate, endDate: new Date(activationDate.getTime() + 6 * 86400000) },
    ],
  });

  // One Breakfast slot in every day-group, so whatever weekday the suite
  // runs on, today's resolved group has the meal.
  for (const dayGroup of DAY_GROUPS) {
    const dayPlan = await DayPlan.create({
      dietPlanId: dietPlan._id,
      patientId: patient._id,
      week: 1,
      dayGroup,
    });
    const mealSlot = await MealSlotPlan.create({ dayPlanId: dayPlan._id, servingTime: 'Breakfast' });
    await PlanItem.create({
      mealSlotId: mealSlot._id,
      recipeVersionId: v1._id,
      calculatedNutrition: v1.nutritionPerServing,
    });
  }

  const versionedId = versionedRecipeKey(recipe._id.toString(), 1);
  return { patient, recipe, versionedId };
}

test('screen-data returns the planned meal with its versioned recipeId and real calories', async () => {
  const { patient, versionedId } = await seedPlanItemPlan();
  registerTestToken('patient-token', patient._id);
  const today = new Date().toISOString().slice(0, 10);

  const res = await request(app)
    .get(`/api/patient/meal-log/screen-data?date=${today}`)
    .set('Authorization', 'Bearer patient-token');

  expect(res.status).toBe(200);
  const breakfast = res.body.data.servingTimes.find((s) => s.servingTime === 'Breakfast');
  expect(breakfast).toBeDefined();
  expect(breakfast.plannedMeals).toHaveLength(1);
  expect(breakfast.plannedMeals[0]).toMatchObject({
    recipeId: versionedId,
    name: 'Oats Porridge',
    calories: 389, // 100g oats @ 389kcal/100g - not the base recipe's bogus 999
    portion: 0, // nothing logged yet
  });
});

test('submitMealLog accepts the versioned recipe key and stores the real Recipe._id', async () => {
  const { patient, recipe, versionedId } = await seedPlanItemPlan();
  registerTestToken('patient-token', patient._id);
  const today = new Date().toISOString().slice(0, 10);

  const res = await request(app)
    .post('/api/patient/meal-log')
    .set('Authorization', 'Bearer patient-token')
    .send({
      date: today,
      items: [{ servingTime: 'Breakfast', recipeId: versionedId, servings: 2, caloriesConsumed: 778 }],
    });

  expect(res.status).toBe(200);
  expect(res.body.success).toBe(true);

  const log = await MealLog.findOne({ patientId: patient._id });
  expect(log).not.toBeNull();
  expect(log.meals).toHaveLength(1);
  expect(log.meals[0].recipeId.toString()).toBe(recipe._id.toString());
  expect(log.meals[0].servings).toBe(2);
});

test('a logged plan-item meal reads back as logged on the next screen-data fetch', async () => {
  const { patient, versionedId } = await seedPlanItemPlan();
  registerTestToken('patient-token', patient._id);
  const today = new Date().toISOString().slice(0, 10);

  await request(app)
    .post('/api/patient/meal-log')
    .set('Authorization', 'Bearer patient-token')
    .send({
      date: today,
      items: [{ servingTime: 'Breakfast', recipeId: versionedId, servings: 3, caloriesConsumed: 1167 }],
    })
    .expect(200);

  const res = await request(app)
    .get(`/api/patient/meal-log/screen-data?date=${today}`)
    .set('Authorization', 'Bearer patient-token');

  expect(res.status).toBe(200);
  const breakfast = res.body.data.servingTimes.find((s) => s.servingTime === 'Breakfast');
  expect(breakfast.plannedMeals[0]).toMatchObject({ recipeId: versionedId, portion: 3 });
});

test("today-stats returns the plan-item plan's real planned calories + macro goals", async () => {
  const { patient } = await seedPlanItemPlan();
  registerTestToken('patient-token', patient._id);
  const today = new Date().toISOString().slice(0, 10);

  const res = await request(app)
    .get(`/api/patient/meal-log/today-stats?date=${today}`)
    .set('Authorization', 'Bearer patient-token');

  expect(res.status).toBe(200);
  // 100g oats @ 389 kcal/100g = 389 (the V1 version's real nutrition, not
  // the base recipe's bogus 999). Was 0 before the plan-item fix.
  expect(res.body.data.summary.totalPlannedCalories).toBeCloseTo(389, 0);
  expect(res.body.data.macros.planned.carbs).toBeCloseTo(66, 0);
  expect(res.body.data.macros.planned.protein).toBeCloseTo(17, 0);
  expect(res.body.data.meals).toHaveLength(1);

  // and a logged plan-item meal shows up as consumed / counted
  const versionedId = versionedRecipeKey(
    res.body.data.meals[0].recipeId.split('::')[0], 1
  );
  await request(app)
    .post('/api/patient/meal-log')
    .set('Authorization', 'Bearer patient-token')
    .send({ date: today, items: [{ servingTime: 'Breakfast', recipeId: versionedId, servings: 1, caloriesConsumed: 389 }] })
    .expect(200);

  const after = await request(app)
    .get(`/api/patient/meal-log/today-stats?date=${today}`)
    .set('Authorization', 'Bearer patient-token');
  expect(after.body.data.summary.totalConsumedCalories).toBeGreaterThan(0);
  expect(after.body.data.summary.loggedCount).toBe(1);
});
