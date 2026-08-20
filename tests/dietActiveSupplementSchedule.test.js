/**
 * GET /api/patient/diet/active - the timed-supplement schedule addition
 * (Phase 6): supplements injected via the dietician wizard's
 * POST .../supplements live in the typed days[] schema, not dailyMeals[],
 * so getActiveDietPlanForPatient must separately surface them (with
 * timingAnchor/dosage/instructions) for the patient app's timeline to
 * render a "Before/With/After <slot>" sub-header.
 */

const { connectTestDb, disconnectTestDb, clearTestDb } = require('./helpers/testDb');

jest.mock('../utils/supabaseAuth');
const { registerTestToken, clearTestTokens } = require('../utils/supabaseAuth');

let request;
let app;
let createPatient;
let createDietician;
let Recipe;
let DietPlan;

beforeAll(async () => {
  await connectTestDb();
  request = require('supertest');
  app = require('../config/createApp')();
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

describe('GET /api/patient/diet/active', () => {
  test('includes supplementSchedule (with timingAnchor) sourced from days[], distinct from dailyMeals', async () => {
    const dietician = await createDietician();
    const patient = await createPatient();
    const mainRecipe = await Recipe.create({
      dieticianId: dietician._id,
      name: 'Poha',
      servingTime: 'Breakfast',
      nutrition: { calories: 300 },
    });
    const supplement = await Recipe.create({
      dieticianId: dietician._id,
      name: 'Multivitamin',
      servingTime: 'Breakfast',
      category: 'Supplements',
    });

    const activationDate = new Date();
    await DietPlan.create({
      patientId: patient._id,
      dieticianId: dietician._id,
      status: 'Active',
      activationDate,
      weekSchedule: [
        { week: 1, startDate: activationDate, endDate: new Date(activationDate.getTime() + 6 * 86400000) },
      ],
      finalizedPlan: {
        weeks: [
          {
            week: 1,
            dailyMeals: [
              { dayGroup: 'Monday', servingTime: 'Breakfast', recipeId: mainRecipe._id.toString(), servings: 1 },
            ],
          },
        ],
      },
      days: [
        {
          week: 1,
          dayGroup: 'Monday',
          meals: [
            {
              servingTime: 'Breakfast',
              items: [{ recipeId: mainRecipe._id, servingMultiplier: 1 }],
              supplements: [
                {
                  supplementId: supplement._id,
                  dosage: '1 tablet',
                  instructions: 'With water',
                  timingAnchor: 'post',
                },
              ],
            },
          ],
        },
      ],
    });

    registerTestToken('patient-token', patient._id);

    const res = await request(app)
      .get('/api/patient/diet/active')
      .set('Authorization', 'Bearer patient-token');

    expect(res.status).toBe(200);
    expect(res.body.data.week.supplementSchedule).toEqual([
      expect.objectContaining({
        dayGroup: 'Monday',
        servingTime: 'Breakfast',
        supplementId: supplement._id.toString(),
        dosage: '1 tablet',
        instructions: 'With water',
        timingAnchor: 'post',
      }),
    ]);

    // The supplement's own recipe data (name) is included in the recipes
    // map even though it's not referenced by any dailyMeals entry.
    expect(res.body.data.recipes[supplement._id.toString()]).toMatchObject({
      name: 'Multivitamin',
    });

    // dailyMeals is unaffected - still just the real food item.
    expect(res.body.data.week.dailyMeals).toHaveLength(1);
    expect(res.body.data.week.dailyMeals[0].recipeId).toBe(mainRecipe._id.toString());

    // weeks[] (the all-weeks cache) carries the same schedule per week.
    expect(res.body.data.weeks[0].supplementSchedule).toHaveLength(1);
  });

  test('supplementSchedule is an empty array for a plan with no injected supplements', async () => {
    const dietician = await createDietician();
    const patient = await createPatient();
    const recipe = await Recipe.create({ dieticianId: dietician._id, name: 'Poha', servingTime: 'Breakfast' });
    const activationDate = new Date();

    await DietPlan.create({
      patientId: patient._id,
      dieticianId: dietician._id,
      status: 'Active',
      activationDate,
      weekSchedule: [
        { week: 1, startDate: activationDate, endDate: new Date(activationDate.getTime() + 6 * 86400000) },
      ],
      finalizedPlan: {
        weeks: [
          {
            week: 1,
            dailyMeals: [
              { dayGroup: 'Monday', servingTime: 'Breakfast', recipeId: recipe._id.toString(), servings: 1 },
            ],
          },
        ],
      },
    });

    registerTestToken('patient-token', patient._id);

    const res = await request(app)
      .get('/api/patient/diet/active')
      .set('Authorization', 'Bearer patient-token');

    expect(res.status).toBe(200);
    expect(res.body.data.week.supplementSchedule).toEqual([]);
  });
});
