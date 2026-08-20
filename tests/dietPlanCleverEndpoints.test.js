/**
 * Phase 3 API endpoints (routes/dietician.js) - exceptions, supplements -
 * exercised end-to-end via supertest against a DietPlan already populated
 * with days[]. Week Tweak/Swap/Swap-vs-Scale coverage was removed here
 * along with those endpoints themselves as part of v4.0's hard cutover
 * (see planItemController.js's header comment) - a days-array plan's
 * Step 5 is read-only now, so only the read-only endpoints remain tested.
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
let DietPlan;

beforeAll(async () => {
  await connectTestDb();
  request = require('supertest');
  app = require('../config/createApp')();
  mongoose = require('mongoose');
  ({ createPatient, createDietician } = require('./helpers/factories'));
  ({ Recipe, DietPlan } = require('../models'));
});

afterEach(async () => {
  clearTestTokens();
  await clearTestDb();
});

afterAll(async () => {
  await disconnectTestDb();
});

async function setup() {
  const dietician = await createDietician();
  const patient = await createPatient();
  const mainRecipe = await Recipe.create({
    dieticianId: dietician._id,
    name: 'Dal',
    servingTime: 'Lunch',
    nutrition: { calories: 500, protein: 20, carbs: 60, fats: 15, fiber: 5 },
  });
  const lighterRecipe = await Recipe.create({
    dieticianId: dietician._id,
    name: 'Light Salad',
    servingTime: 'Lunch',
    nutrition: { calories: 200, protein: 10, carbs: 20, fats: 5, fiber: 3 },
  });
  const supplement = await Recipe.create({
    dieticianId: dietician._id,
    name: 'Multivitamin',
    servingTime: 'Breakfast',
    category: 'Supplements',
  });

  const dietPlan = await DietPlan.create({
    patientId: patient._id,
    dieticianId: dietician._id,
    status: 'Finalized',
    calorieStrategy: { calorieBudget: 2000 },
    days: [
      {
        week: 1,
        dayGroup: 'Monday',
        meals: [{ servingTime: 'Lunch', items: [{ recipeId: mainRecipe._id, servingMultiplier: 1, locked: false }] }],
      },
    ],
  });
  const itemId = dietPlan.days[0].meals[0].items[0]._id.toString();

  registerTestToken('dietician-token', dietician._id);
  return { dietician, patient, dietPlan, mainRecipe, lighterRecipe, supplement, itemId };
}

const auth = (req) => req.set('Authorization', 'Bearer dietician-token');

describe('GET .../weeks/:week/exceptions', () => {
  test('flags a day whose recomputed total is outside tolerance', async () => {
    const { patient, dietPlan } = await setup();

    const res = await auth(
      request(app).get(`/api/dietician/patients/${patient._id}/diet-plans/${dietPlan._id}/weeks/1/exceptions`)
    );

    expect(res.status).toBe(200);
    // 500 cal actual vs 2000 cal budget - well outside the default 10% tolerance.
    expect(res.body.data.calorieExceptions).toHaveLength(1);
    expect(res.body.data.calorieExceptions[0]).toMatchObject({ dayGroup: 'Monday', actualCalories: 500 });
  });
});

describe('GET .../weeks/:week/days', () => {
  test('returns days[] with item/supplement subdocument ids and joined recipe names', async () => {
    const { patient, dietPlan, mainRecipe, supplement } = await setup();

    // Inject a supplement first, so the response also covers that array.
    await auth(
      request(app).post(`/api/dietician/patients/${patient._id}/diet-plans/${dietPlan._id}/supplements`)
    ).send({
      week: 1,
      dayGroup: 'Monday',
      servingTime: 'Lunch',
      supplementId: supplement._id.toString(),
      dosage: '1 tablet',
      timingAnchor: 'post',
    });

    const res = await auth(
      request(app).get(`/api/dietician/patients/${patient._id}/diet-plans/${dietPlan._id}/weeks/1/days`)
    );

    expect(res.status).toBe(200);
    expect(res.body.data.week).toBe(1);
    const monday = res.body.data.days.find((d) => d.dayGroup === 'Monday');
    const lunch = monday.meals.find((m) => m.servingTime === 'Lunch');

    expect(lunch.items).toHaveLength(1);
    expect(lunch.items[0]).toMatchObject({
      recipeId: mainRecipe._id.toString(),
      recipeName: 'Dal',
      servingMultiplier: 1,
    });
    expect(typeof lunch.items[0].itemId).toBe('string');

    expect(lunch.supplements).toEqual([
      expect.objectContaining({
        supplementId: supplement._id.toString(),
        supplementName: 'Multivitamin',
        dosage: '1 tablet',
        timingAnchor: 'post',
      }),
    ]);
  });

  test('returns an empty days array for a week with no data', async () => {
    const { patient, dietPlan } = await setup();
    const res = await auth(
      request(app).get(`/api/dietician/patients/${patient._id}/diet-plans/${dietPlan._id}/weeks/2/days`)
    );
    expect(res.status).toBe(200);
    expect(res.body.data.days).toEqual([]);
  });
});

describe('POST .../supplements', () => {
  test('injects a new supplement into the given slot with a timingAnchor', async () => {
    const { patient, dietPlan, supplement } = await setup();

    const res = await auth(
      request(app).post(`/api/dietician/patients/${patient._id}/diet-plans/${dietPlan._id}/supplements`)
    ).send({
      week: 1,
      dayGroup: 'Monday',
      servingTime: 'Breakfast', // no meal entry exists yet for this slot - must be created
      supplementId: supplement._id.toString(),
      dosage: '1 tablet',
      instructions: 'With water',
      timingAnchor: 'post',
    });

    expect(res.status).toBe(200);

    const saved = await DietPlan.findById(dietPlan._id).lean();
    const breakfast = saved.days[0].meals.find((m) => m.servingTime === 'Breakfast');
    expect(breakfast.supplements).toEqual([
      expect.objectContaining({ dosage: '1 tablet', timingAnchor: 'post' }),
    ]);
  });

  test('updating the same supplement again replaces its fields, not duplicates the entry', async () => {
    const { patient, dietPlan, supplement } = await setup();
    const body = {
      week: 1,
      dayGroup: 'Monday',
      servingTime: 'Breakfast',
      supplementId: supplement._id.toString(),
      timingAnchor: 'post',
    };
    await auth(
      request(app).post(`/api/dietician/patients/${patient._id}/diet-plans/${dietPlan._id}/supplements`)
    ).send({ ...body, dosage: '1 tablet' });
    await auth(
      request(app).post(`/api/dietician/patients/${patient._id}/diet-plans/${dietPlan._id}/supplements`)
    ).send({ ...body, dosage: '2 tablets' });

    const saved = await DietPlan.findById(dietPlan._id).lean();
    const breakfast = saved.days[0].meals.find((m) => m.servingTime === 'Breakfast');
    expect(breakfast.supplements).toHaveLength(1);
    expect(breakfast.supplements[0].dosage).toBe('2 tablets');
  });

  test('rejects an invalid timingAnchor', async () => {
    const { patient, dietPlan, supplement } = await setup();
    const res = await auth(
      request(app).post(`/api/dietician/patients/${patient._id}/diet-plans/${dietPlan._id}/supplements`)
    ).send({
      week: 1,
      dayGroup: 'Monday',
      servingTime: 'Breakfast',
      supplementId: supplement._id.toString(),
      timingAnchor: 'sometime',
    });
    expect(res.status).toBe(400);
  });
});
