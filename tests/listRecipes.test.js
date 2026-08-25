/**
 * controllers/dietician/uploadRecipieController.js::listRecipes -
 * GET /api/dietician/recipes. Covers the side/salad cross-listing fix: a
 * dietician manually adding/swapping a recipe for Lunch/Dinner/Evening
 * Snack should see side/salad-tagged recipes too (same eligibility
 * services/recipeSelectionEngine.js already applies at AI-generation time),
 * not just recipes whose own servingTime happens to match exactly.
 */

const { connectTestDb, disconnectTestDb, clearTestDb } = require('./helpers/testDb');

jest.mock('../utils/supabaseAuth');
const { registerTestToken, clearTestTokens } = require('../utils/supabaseAuth');

let request;
let app;
let createDietician;
let Recipe;

beforeAll(async () => {
  await connectTestDb();
  request = require('supertest');
  app = require('../config/createApp')();
  ({ createDietician } = require('./helpers/factories'));
  ({ Recipe } = require('../models'));
});

afterEach(async () => {
  clearTestTokens();
  await clearTestDb();
});

afterAll(async () => {
  await disconnectTestDb();
});

const auth = (req) => req.set('Authorization', 'Bearer dietician-token');

async function seedRecipes(dieticianId) {
  const lunchMain = await Recipe.create({ dieticianId, name: 'Dal Rice', servingTime: 'Lunch' });
  const breakfastMain = await Recipe.create({ dieticianId, name: 'Poha', servingTime: 'Breakfast' });
  const salad = await Recipe.create({ dieticianId, name: 'Kachumber Salad', servingTime: 'Breakfast', tags: ['salad'] });
  const side = await Recipe.create({ dieticianId, name: 'Chapati', servingTime: 'Breakfast', tags: ['side'] });
  return { lunchMain, breakfastMain, salad, side };
}

describe('GET /recipes', () => {
  test('Lunch includes side/salad-tagged recipes regardless of their own servingTime', async () => {
    const dietician = await createDietician();
    registerTestToken('dietician-token', dietician._id);
    const { lunchMain, salad, side } = await seedRecipes(dietician._id);

    const res = await auth(request(app).get('/api/dietician/recipes').query({ servingTime: 'Lunch' }));
    expect(res.status).toBe(200);
    const ids = res.body.data.map((r) => r.id);
    expect(ids).toEqual(expect.arrayContaining([String(lunchMain._id), String(salad._id), String(side._id)]));
  });

  test('Dinner also includes side/salad-tagged recipes (the reported gap)', async () => {
    const dietician = await createDietician();
    registerTestToken('dietician-token', dietician._id);
    const { salad, side } = await seedRecipes(dietician._id);

    const res = await auth(request(app).get('/api/dietician/recipes').query({ servingTime: 'Dinner' }));
    expect(res.status).toBe(200);
    const ids = res.body.data.map((r) => r.id);
    expect(ids).toEqual(expect.arrayContaining([String(salad._id), String(side._id)]));
  });

  test('a non-eligible slot (Breakfast) does not pull in side/salad recipes from elsewhere', async () => {
    const dietician = await createDietician();
    registerTestToken('dietician-token', dietician._id);
    const { salad, side } = await seedRecipes(dietician._id);
    // Move the salad/side to Lunch - they'd only show up under Breakfast via broadening.
    await Recipe.updateMany({ tags: { $in: ['side', 'salad'] } }, { $set: { servingTime: 'Lunch' } });

    const res = await auth(request(app).get('/api/dietician/recipes').query({ servingTime: 'Breakfast' }));
    expect(res.status).toBe(200);
    const ids = res.body.data.map((r) => r.id);
    expect(ids).not.toEqual(expect.arrayContaining([String(salad._id), String(side._id)]));
  });

  test('response includes each recipe\'s tags', async () => {
    const dietician = await createDietician();
    registerTestToken('dietician-token', dietician._id);
    const { salad } = await seedRecipes(dietician._id);

    const res = await auth(request(app).get('/api/dietician/recipes').query({ servingTime: 'Lunch' }));
    const saladEntry = res.body.data.find((r) => r.id === String(salad._id));
    expect(saladEntry.tags).toEqual(['salad']);
  });
});
