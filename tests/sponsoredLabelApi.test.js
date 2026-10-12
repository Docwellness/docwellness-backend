/**
 * The patient app's active diet plan must carry the disclosure label for a
 * live commercial image, and only for that
 * (openspec add-admin-panel: admin-product-placements).
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

async function seedPlan({ supplementFields, mainFields }) {
  const dietician = await createDietician();
  const patient = await createPatient();
  const main = await Recipe.create({
    dieticianId: dietician._id,
    name: 'Poha',
    servingTime: 'Breakfast',
    nutrition: { calories: 300 },
    ...mainFields,
  });
  const supplement = await Recipe.create({
    dieticianId: dietician._id,
    name: 'Whey Protein',
    servingTime: 'Breakfast',
    category: 'Supplements',
    ...supplementFields,
  });
  const start = new Date();
  await DietPlan.create({
    patientId: patient._id,
    dieticianId: dietician._id,
    status: 'Active',
    activationDate: start,
    weekSchedule: [{ week: 1, startDate: start, endDate: new Date(start.getTime() + 6 * 86400000) }],
    finalizedPlan: {
      weeks: [
        {
          week: 1,
          dailyMeals: [{ dayGroup: 'Monday', servingTime: 'Breakfast', recipeId: main._id.toString(), servings: 1 }],
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
            items: [{ recipeId: main._id, servingMultiplier: 1 }],
            supplements: [{ supplementId: supplement._id, dosage: '1 scoop', instructions: 'Mix in water', timingAnchor: 'post' }],
          },
        ],
      },
    ],
  });
  registerTestToken('patient-token', patient._id);
  return { main, supplement };
}

const getActive = () => request(app).get('/api/patient/diet/active').set('Authorization', 'Bearer patient-token');

describe('GET /api/patient/diet/active - sponsored label', () => {
  test('a live commercial image carries its disclosure; other recipes carry none', async () => {
    const { main, supplement } = await seedPlan({
      supplementFields: {
        image: 'https://res.cloudinary.com/x/commercial.jpg',
        imageSource: 'commercial',
        sponsoredLabel: 'Paid partnership',
      },
      mainFields: { image: 'https://res.cloudinary.com/x/ai.jpg', imageSource: 'ai-generated' },
    });
    const res = await getActive();
    expect(res.status).toBe(200);
    const recipes = res.body.data.recipes;
    expect(recipes[supplement._id.toString()]).toMatchObject({
      image: 'https://res.cloudinary.com/x/commercial.jpg',
      sponsoredLabel: 'Paid partnership',
    });
    expect(recipes[main._id.toString()].sponsoredLabel).toBeNull();
  });

  test('a commercial image without a stored label still shows "Sponsored"', async () => {
    const { supplement } = await seedPlan({
      supplementFields: { image: 'https://res.cloudinary.com/x/commercial.jpg', imageSource: 'commercial' },
      mainFields: {},
    });
    const res = await getActive();
    expect(res.body.data.recipes[supplement._id.toString()].sponsoredLabel).toBe('Sponsored');
  });

  test('a leftover label never shows once the image is no longer commercial', async () => {
    const { supplement } = await seedPlan({
      supplementFields: {
        image: 'https://res.cloudinary.com/x/ai.jpg',
        imageSource: 'ai-generated',
        sponsoredLabel: 'Sponsored',
      },
      mainFields: {},
    });
    const res = await getActive();
    expect(res.body.data.recipes[supplement._id.toString()].sponsoredLabel).toBeNull();
  });
});
