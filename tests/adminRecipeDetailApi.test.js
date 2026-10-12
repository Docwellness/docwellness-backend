/**
 * Admin recipe detail (openspec add-admin-panel: admin-content-management).
 */
const { connectTestDb, disconnectTestDb, clearTestDb } = require('./helpers/testDb');

jest.mock('../middlewares/adminAuth', () => ({
  adminAuth: (req, res, next) => {
    req.admin = { email: 'docwellness.fit@gmail.com', user: { _id: '000000000000000000000009' }, permissions: {} };
    next();
  },
  requirePermission: () => (req, res, next) => next(),
}));

let request, app, f, Recipe, User;

beforeAll(async () => {
  await connectTestDb();
  request = require('supertest');
  app = require('../config/createApp')();
  f = require('./helpers/factories');
  Recipe = require('../models/Recipe');
  User = require('../models/User');
});
afterEach(async () => {
  await clearTestDb();
});
afterAll(async () => {
  await disconnectTestDb();
});

const get = (p) => request(app).get(`/api/admin${p}`);

describe('recipe detail', () => {
  it('returns what the dietician app shows: ingredients, steps, nutrition, translations and owner', async () => {
    const d = await f.createDietician();
    await User.updateOne({ _id: d._id }, { $set: { 'profile.fullName': 'Dr Meera' } });
    const r = await Recipe.create({
      dieticianId: d._id,
      name: 'Moong Dal Khichdi',
      category: 'Indian',
      servingTime: 'Lunch',
      servings: 2,
      ingredients: [{ name: 'Moong dal', quantity: 100, unit: 'g', role: 'core' }],
      instructions: ['Wash the dal', 'Pressure cook'],
      nutrition: { calories: 420, protein: 18 },
      dietaryHabits: { vegetarian: true },
      translations: { Hindi: { name: 'मूंग दाल खिचड़ी', cookingSteps: ['दाल धोएं'] } },
    });

    const res = await get(`/content/recipes/${r._id}`);
    expect(res.status).toBe(200);
    const d1 = res.body.data;
    expect(d1).toMatchObject({ name: 'Moong Dal Khichdi', servings: 2, ownerName: 'Dr Meera' });
    expect(d1.cookingSteps).toEqual(['Wash the dal', 'Pressure cook']);
    expect(d1.instructions).toBeUndefined();
    expect(d1.dieticianId).toBeUndefined();
    expect(d1.ingredients[0]).toMatchObject({ name: 'Moong dal', quantity: 100, role: 'core' });
    expect(d1.nutrition.calories).toBe(420);
    expect(d1.translations.Hindi.name).toBe('मूंग दाल खिचड़ी');
  });

  it('rejects a malformed id and 404s for an unknown recipe', async () => {
    expect((await get('/content/recipes/not-an-id')).status).toBe(400);
    expect((await get('/content/recipes/000000000000000000000001')).status).toBe(404);
  });

  it('is not shadowed by the summary route', async () => {
    expect((await get('/content/recipes/summary')).status).toBe(200);
  });
});
