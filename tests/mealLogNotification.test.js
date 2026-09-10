/**
 * Regression tests for the dietician-facing notification raised when a
 * patient logs a meal (POST /api/patient/meal-log -> dietController.submitMealLog).
 *
 * Pins two behaviours the "clean up meal-log data sync" change introduced:
 *  1. The notification is routed to the patient's ASSIGNED dietician (the one
 *     on their DietPlan), not the global config.defaultDieticianId.
 *  2. Every submission that logs something raises its own notification - a
 *     second meal on the same day is not silently swallowed - and each
 *     notification carries data.patientId so the app can deep-link to that
 *     patient's "Client Logged Data" sheet.
 */

const { connectTestDb, disconnectTestDb, clearTestDb } = require('./helpers/testDb');

jest.mock('../utils/supabaseAuth');
const { registerTestToken, clearTestTokens } = require('../utils/supabaseAuth');

let request;
let app;
let createPatient;
let createDietician;
let createDefaultDietician;
let createActiveDietPlan;
let Notification;
let Recipe;

beforeAll(async () => {
  await connectTestDb();
  request = require('supertest');
  app = require('../config/createApp')();
  ({ createPatient, createDietician, createDefaultDietician, createActiveDietPlan } =
    require('./helpers/factories'));
  ({ Notification, Recipe } = require('../models'));
});

afterEach(async () => {
  clearTestTokens();
  await clearTestDb();
});

afterAll(async () => {
  await disconnectTestDb();
});

function createRecipe(dietician, overrides = {}) {
  return Recipe.create({
    dieticianId: dietician._id,
    name: 'Test Oatmeal',
    servingTime: 'Breakfast',
    ...overrides,
  });
}

function logMeal(token, recipeId, overrides = {}) {
  return request(app)
    .post('/api/patient/meal-log')
    .set('Authorization', `Bearer ${token}`)
    .send({
      date: new Date().toISOString().slice(0, 10),
      items: [
        {
          servingTime: 'Breakfast',
          recipeId: recipeId.toString(),
          servings: 1,
          caloriesConsumed: 250,
          ...overrides,
        },
      ],
    });
}

describe('meal-log dietician notification', () => {
  test('routes the notification to the patient\'s assigned dietician, not the default', async () => {
    await createDefaultDietician();
    const assigned = await createDietician();
    const patient = await createPatient();
    await createActiveDietPlan(patient, assigned);
    const recipe = await createRecipe(assigned);
    registerTestToken('patient-token', patient._id);

    const res = await logMeal('patient-token', recipe._id);
    expect(res.status).toBe(200);

    const notifs = await Notification.find({ type: 'progress' });
    expect(notifs).toHaveLength(1);
    expect(notifs[0].userId.toString()).toBe(assigned._id.toString());
    expect(notifs[0].data).toMatchObject({ patientId: patient._id.toString() });
  });

  test('raises a fresh notification for every meal logged the same day', async () => {
    const dietician = await createDefaultDietician();
    const patient = await createPatient();
    await createActiveDietPlan(patient, dietician);
    const breakfast = await createRecipe(dietician, { name: 'Oats', servingTime: 'Breakfast' });
    const lunch = await createRecipe(dietician, { name: 'Dal Rice', servingTime: 'Lunch' });
    registerTestToken('patient-token', patient._id);

    await logMeal('patient-token', breakfast._id, { servingTime: 'Breakfast' });
    await logMeal('patient-token', lunch._id, { servingTime: 'Lunch' });

    const notifs = await Notification.find({ type: 'progress' });
    expect(notifs.length).toBe(2);
    notifs.forEach((n) => {
      expect(n.data).toMatchObject({ patientId: patient._id.toString() });
    });
  });

  test('falls back to the default dietician for a patient with no diet plan', async () => {
    const fallback = await createDefaultDietician();
    const patient = await createPatient();
    const recipe = await createRecipe(fallback);
    registerTestToken('patient-token', patient._id);

    const res = await logMeal('patient-token', recipe._id);
    expect(res.status).toBe(200);

    const notif = await Notification.findOne({ type: 'progress' });
    expect(notif).not.toBeNull();
    expect(notif.userId.toString()).toBe(fallback._id.toString());
  });
});
