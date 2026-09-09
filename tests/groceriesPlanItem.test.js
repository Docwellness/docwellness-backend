/**
 * GET /api/patient/diet/groceries for a 'plan-item' DietPlan.
 *
 * Regression guard: getGroceriesForCurrentWeek called getFinalizedWeeks
 * directly, which returns [] for a v4.0 plan-item plan (no finalizedPlan
 * blob) - so the grocery list showed "isn't ready yet" for every plan-item
 * patient even with a fully finalized plan. It must now synthesize the same
 * weeks from DayPlan/MealSlotPlan/PlanItem, take the RecipeVersion's exact
 * ingredient quantities as-is (no component scaling), and fold in the
 * SupplementItem schedule as line items.
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
let Ingredient;
let DietPlan;
let DayPlan;
let MealSlotPlan;
let PlanItem;
let SupplementItem;

beforeAll(async () => {
  await connectTestDb();
  request = require('supertest');
  app = require('../config/createApp')();
  ({ createPatient, createDietician } = require('./helpers/factories'));
  ({ Recipe, FoodItem, RecipeVersion, Ingredient, DietPlan, DayPlan, MealSlotPlan, PlanItem, SupplementItem } = require('../models'));
});

afterEach(async () => {
  clearTestTokens();
  await clearTestDb();
});

afterAll(async () => {
  await disconnectTestDb();
});

test('builds the grocery list (food + supplements) for a finalized plan-item plan', async () => {
  const dietician = await createDietician();
  const patient = await createPatient();

  await FoodItem.create({
    name: 'Oats',
    normalizedName: 'oats',
    nutritionPer100g: { calories: 389, protein: 17, carbs: 66, fats: 7, fiber: 10 },
  });
  await Ingredient.create({
    dieticianId: dietician._id,
    name: 'Oats',
    normalizedName: 'oats',
    category: 'Grains',
    unitConversions: { g: 1 },
  });

  // Base recipe authored at 100g oats; a non-1 component quantity is the
  // exact condition that would trip the component-ratio path if it weren't
  // skipped for plan-item (ratio would be 1 / 100).
  const recipe = await Recipe.create({
    dieticianId: dietician._id,
    name: 'Oats Porridge',
    servingTime: 'Breakfast',
    components: [{ label: 'Oats Porridge', quantity: 100, unit: 'g' }],
    ingredients: [{ name: 'Oats', quantity: 100, unit: 'g' }],
    nutrition: { calories: 389, protein: 17, carbs: 66, fats: 7, fiber: 10 },
  });
  await new Promise((resolve) => setTimeout(resolve, 60)); // V1 sync hook
  const v1 = await RecipeVersion.findOne({ parentRecipeId: recipe._id, versionNumber: 1 });

  const activationDate = new Date();
  const dietPlan = await DietPlan.create({
    patientId: patient._id,
    dieticianId: dietician._id,
    status: 'Active',
    dataModel: 'plan-item',
    activationDate,
    weekSchedule: [{ week: 1, startDate: activationDate, endDate: new Date(activationDate.getTime() + 6 * 86400000) }],
  });

  // Same breakfast on Monday and Tuesday -> the two occurrences must
  // collapse into one grocery row with the summed quantity (200g).
  for (const dayGroup of ['Monday', 'Tuesday']) {
    const dayPlan = await DayPlan.create({ dietPlanId: dietPlan._id, patientId: patient._id, week: 1, dayGroup });
    const mealSlot = await MealSlotPlan.create({ dayPlanId: dayPlan._id, servingTime: 'Breakfast' });
    await PlanItem.create({ mealSlotId: mealSlot._id, recipeVersionId: v1._id, calculatedNutrition: v1.nutritionPerServing });
    if (dayGroup === 'Monday') {
      const supplement = await Recipe.create({
        dieticianId: dietician._id,
        name: 'Multivitamin',
        servingTime: 'Breakfast',
        category: 'Supplements',
        ingredients: [{ name: 'Multivitamin Tablet', quantity: 1, unit: 'piece' }],
      });
      await SupplementItem.create({ mealSlotId: mealSlot._id, supplementRecipeId: supplement._id, dosage: '1 tablet', timingAnchor: 'post' });
    }
  }

  registerTestToken('patient-token', patient._id);
  const res = await request(app).get('/api/patient/diet/groceries').set('Authorization', 'Bearer patient-token');

  expect(res.status).toBe(200);
  expect(res.body.data.weeks).toHaveLength(1);
  const week1 = res.body.data.weeks[0];
  expect(week1.week).toBe(1);

  const oats = week1.items.find((i) => /oats/i.test(i.name));
  expect(oats).toBeTruthy();
  // Exact prescribed amount, summed across both days - NOT divided by the
  // component's base quantity of 100.
  expect(oats.totalQuantity).toBe(200);
  expect(oats.recipesUsedIn).toHaveLength(1); // Monday + Tuesday collapsed

  const multivitamin = week1.items.find((i) => i.isSupplement);
  expect(multivitamin).toBeTruthy();
  expect(multivitamin.name).toBe('Multivitamin Tablet');
});
