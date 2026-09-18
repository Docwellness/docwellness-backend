/**
 * POST /recipes/ai-generate-preview (controllers/dietician/
 * uploadRecipieController.js's generateRecipeWithAI) - the initial
 * AI-generate-a-new-recipe flow. Found during implementation of
 * openspec/changes/unify-recipe-ingredients-and-components: this preview
 * response was silently dropping `role` from each mapped ingredient, unlike
 * the sibling updateRecipeFromEdits/enhanceIngredient - meaning a freshly
 * AI-generated recipe's core/sub split never reached the dietician app.
 */
const { connectTestDb, disconnectTestDb, clearTestDb } = require('./helpers/testDb');

jest.mock('../utils/openaiClient', () => ({
  generateRecipeWithAI: jest.fn().mockResolvedValue({
    name: 'Chapati',
    description: 'A simple flatbread.',
    category: 'Indian',
    cuisine: 'Indian',
    preparationTime: 5,
    cookingTime: 10,
    ingredients: [
      { name: 'Whole Wheat Flour', quantity: 100, unit: 'g', category: 'Carbohydrate', priceLevel: '₹₹', description: '', isScalable: true, role: 'core' },
      { name: 'Water', quantity: 60, unit: 'g', category: 'Other', priceLevel: '₹₹', description: '', isScalable: true, role: 'sub' },
    ],
    components: [{ label: 'Chapati', quantity: 1, unit: 'piece' }],
    nutrition: { calories: 120, protein: 3, carbs: 24, fats: 1, fiber: 2 },
    cookingSteps: ['Mix flour and water.', 'Roll and cook on a tawa.'],
    warnings: [],
  }),
}));
jest.mock('../utils/supabaseAuth');
const { registerTestToken, clearTestTokens } = require('../utils/supabaseAuth');

let request;
let app;
let createDietician;

beforeAll(async () => {
  await connectTestDb();
  request = require('supertest');
  app = require('../config/createApp')();
  ({ createDietician } = require('./helpers/factories'));
});

afterEach(async () => {
  clearTestTokens();
  await clearTestDb();
});

afterAll(async () => {
  await disconnectTestDb();
});

test('preview response includes `role` per ingredient, matching the AI output', async () => {
  const dietician = await createDietician();
  registerTestToken('dietician-token', dietician._id);

  const res = await request(app)
    .post('/api/dietician/recipes/ai-generate-preview')
    .set('Authorization', 'Bearer dietician-token')
    .send({
      name: 'Chapati',
      servingTime: 'Lunch',
      servings: 1,
      dietaryHabits: {},
      freeFrom: {},
    });

  expect(res.status).toBe(200);
  const byName = Object.fromEntries(res.body.data.ingredients.map((i) => [i.name, i.role]));
  expect(byName['Whole Wheat Flour']).toBe('core');
  expect(byName['Water']).toBe('sub');
});
