/**
 * AI_EXECUTION_PLAN.md Phase 8, P8-01 - meal log create. Tests the live
 * write path the app actually calls (POST /api/patient/meal-log ->
 * dietController.submitMealLog) - not the separate, currently-unused
 * POST /api/patient/meal-logs (plural, mealLogController.createMealLog).
 */

const { connectTestDb, disconnectTestDb, clearTestDb } = require('./helpers/testDb');

jest.mock('../utils/supabaseAuth');
const { registerTestToken, clearTestTokens } = require('../utils/supabaseAuth');

let request;
let app;
let createPatient;
let createDefaultDietician;
let MealLog;
let Recipe;

beforeAll(async () => {
  await connectTestDb();
  request = require('supertest');
  app = require('../config/createApp')();
  ({ createPatient, createDefaultDietician } = require('./helpers/factories'));
  ({ MealLog, Recipe } = require('../models'));
});

afterEach(async () => {
  clearTestTokens();
  await clearTestDb();
});

afterAll(async () => {
  await disconnectTestDb();
});

async function createRecipe(dietician, overrides = {}) {
  return Recipe.create({
    dieticianId: dietician._id,
    name: 'Test Oatmeal',
    servingTime: 'Breakfast',
    ...overrides,
  });
}

describe('POST /api/patient/meal-log', () => {
  test('creates a meal log entry for today for the authenticated patient', async () => {
    const dietician = await createDefaultDietician();
    const patient = await createPatient();
    const recipe = await createRecipe(dietician);
    registerTestToken('patient-token', patient._id);

    const today = new Date().toISOString().slice(0, 10);

    const res = await request(app)
      .post('/api/patient/meal-log')
      .set('Authorization', 'Bearer patient-token')
      .send({
        date: today,
        items: [
          {
            servingTime: 'Breakfast',
            recipeId: recipe._id.toString(),
            servings: 1,
            caloriesConsumed: 250,
          },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.summary.Breakfast).toEqual({
      totalServings: 1,
      totalCalories: 250,
    });

    const stored = await MealLog.findOne({ patientId: patient._id });
    expect(stored).not.toBeNull();
    expect(stored.meals.length).toBe(1);
    expect(stored.meals[0].recipeId.toString()).toBe(recipe._id.toString());
    expect(stored.totalCalories).toBe(250);
  });

  test('overwrites servings for the same servingTime+recipe on a second submission', async () => {
    const dietician = await createDefaultDietician();
    const patient = await createPatient();
    const recipe = await createRecipe(dietician);
    registerTestToken('patient-token', patient._id);
    const today = new Date().toISOString().slice(0, 10);
    const body = {
      date: today,
      items: [{ servingTime: 'Breakfast', recipeId: recipe._id.toString(), servings: 1, caloriesConsumed: 250 }],
    };

    await request(app).post('/api/patient/meal-log').set('Authorization', 'Bearer patient-token').send(body);
    await request(app)
      .post('/api/patient/meal-log')
      .set('Authorization', 'Bearer patient-token')
      .send({
        ...body,
        items: [{ servingTime: 'Breakfast', recipeId: recipe._id.toString(), servings: 2, caloriesConsumed: 500 }],
      });

    const stored = await MealLog.findOne({ patientId: patient._id });
    expect(stored.meals.length).toBe(1);
    expect(stored.meals[0].servings).toBe(2);
    expect(stored.totalCalories).toBe(500);
  });

  test('rejects a future date', async () => {
    const dietician = await createDefaultDietician();
    const patient = await createPatient();
    const recipe = await createRecipe(dietician);
    registerTestToken('patient-token', patient._id);

    const future = new Date();
    future.setDate(future.getDate() + 1);

    const res = await request(app)
      .post('/api/patient/meal-log')
      .set('Authorization', 'Bearer patient-token')
      .send({
        date: future.toISOString().slice(0, 10),
        items: [{ servingTime: 'Breakfast', recipeId: recipe._id.toString(), servings: 1 }],
      });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  test('rejects an empty items array', async () => {
    const patient = await createPatient();
    registerTestToken('patient-token', patient._id);

    const res = await request(app)
      .post('/api/patient/meal-log')
      .set('Authorization', 'Bearer patient-token')
      .send({ date: new Date().toISOString().slice(0, 10), items: [] });

    expect(res.status).toBe(400);
  });

  test('rejects an item with an invalid recipeId', async () => {
    const patient = await createPatient();
    registerTestToken('patient-token', patient._id);

    const res = await request(app)
      .post('/api/patient/meal-log')
      .set('Authorization', 'Bearer patient-token')
      .send({
        date: new Date().toISOString().slice(0, 10),
        items: [{ servingTime: 'Breakfast', recipeId: 'not-an-id', servings: 1 }],
      });

    expect(res.status).toBe(400);
  });
});
