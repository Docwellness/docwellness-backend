/**
 * GET /api/patient/diet/active for a 'plan-item' DietPlan - proves the
 * v4.0 read path end-to-end through the real endpoint, not just
 * dietPlanReadDispatch.js in isolation. Specifically guards against the
 * ratio bug caught while building this: getRecipesForServing (patient
 * Flutter app) computes `meal.servings / recipe.servingSize.quantity` to
 * decide how much to rescale a recipe's nutrition - naively sending
 * `servings: 1` without also pinning the recipe's own servingSize.quantity
 * to 1 would silently divide by the base recipe's real (non-1)
 * servingSize and badly under/over-scale every plan-item meal's displayed
 * nutrition.
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
let SupplementItem;

beforeAll(async () => {
  await connectTestDb();
  request = require('supertest');
  app = require('../config/createApp')();
  mongoose = require('mongoose');
  ({ createPatient, createDietician } = require('./helpers/factories'));
  ({ Recipe, FoodItem, RecipeVersion, DietPlan, DayPlan, MealSlotPlan, PlanItem, SupplementItem } = require('../models'));
});

afterEach(async () => {
  clearTestTokens();
  await clearTestDb();
});

afterAll(async () => {
  await disconnectTestDb();
});

test('returns real (not mis-scaled) nutrition, exact ingredients/steps, and the supplement schedule for a plan-item plan', async () => {
  const dietician = await createDietician();
  const patient = await createPatient();

  const oats = await FoodItem.create({
    name: 'Oats',
    normalizedName: 'oats',
    nutritionPer100g: { calories: 389, protein: 17, carbs: 66, fats: 7, fiber: 10 },
  });
  // A base recipe with a deliberately non-1 legacy servingSize.quantity
  // (250g) - the exact condition that would trip the ratio bug if
  // servingSize.quantity weren't overridden alongside dailyMeals[].servings.
  const recipe = await Recipe.create({
    dieticianId: dietician._id,
    name: 'Oats Porridge',
    servingTime: 'Breakfast',
    servingSize: { quantity: 250, unit: 'g' },
    components: [{ label: 'Oats Porridge', quantity: 100, unit: 'g' }],
    ingredients: [{ name: 'Oats', quantity: 100, unit: 'g' }],
    nutrition: { calories: 999, protein: 999, carbs: 999, fats: 999, fiber: 999 }, // deliberately wrong, must be overridden
  });
  await new Promise((resolve) => setTimeout(resolve, 60)); // let the post-save V1 sync hook land
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
  const dayPlan = await DayPlan.create({ dietPlanId: dietPlan._id, patientId: patient._id, week: 1, dayGroup: 'Monday' });
  const mealSlot = await MealSlotPlan.create({ dayPlanId: dayPlan._id, servingTime: 'Breakfast' });
  await PlanItem.create({ mealSlotId: mealSlot._id, recipeVersionId: v1._id, calculatedNutrition: v1.nutritionPerServing });

  const supplement = await Recipe.create({ dieticianId: dietician._id, name: 'Multivitamin', servingTime: 'Breakfast', category: 'Supplements' });
  await SupplementItem.create({ mealSlotId: mealSlot._id, supplementRecipeId: supplement._id, dosage: '1 tablet', timingAnchor: 'post' });

  registerTestToken('patient-token', patient._id);

  const res = await request(app).get('/api/patient/diet/active').set('Authorization', 'Bearer patient-token');

  expect(res.status).toBe(200);
  const meal = res.body.data.week.dailyMeals[0];
  expect(meal).toMatchObject({ dayGroup: 'Monday', servingTime: 'Breakfast', recipeId: recipe._id.toString(), servings: 1 });

  const recipeInResponse = res.body.data.recipes[recipe._id.toString()];
  // servingSize.quantity pinned to 1 alongside servings:1 above - the ratio
  // getRecipesForServing computes is exactly 1, no client-side rescale.
  expect(recipeInResponse.servingSize.quantity).toBe(1);
  // The REAL per-ingredient nutrition (100g oats @ 389kcal/100g = 389),
  // not the base Recipe's bogus authored 999 value.
  expect(recipeInResponse.nutritionPerServing.calories).toBeCloseTo(389);
  expect(recipeInResponse.ingredients).toEqual([{ name: 'Oats', quantity: 100, unit: 'g', image: null, isScalable: true }]);
  // components is what food_card.dart's FoodCard actually renders (it only
  // falls back to servingSize.quantity/unit when components is empty) -
  // must reflect the real per-ingredient quantity, not the base recipe's
  // possibly-stale components[] or the misleading pinned servingSize=1.
  expect(recipeInResponse.components).toEqual([{ label: 'Oats', quantity: 100, unit: 'g' }]);

  expect(res.body.data.week.supplementSchedule).toEqual([
    expect.objectContaining({ dayGroup: 'Monday', servingTime: 'Breakfast', supplementId: supplement._id.toString(), dosage: '1 tablet', timingAnchor: 'post' }),
  ]);
});
