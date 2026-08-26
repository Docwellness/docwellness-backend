/**
 * POST /api/dietician/recipes/backfill-cooking-steps
 * (controllers/dietician/uploadRecipieController.js's backfillCookingSteps) -
 * exists as an HTTP route (not just scripts/backfill-hand-authored-recipe-
 * steps.js) so it can be triggered against prod without direct database
 * access - see that route's own doc comment for why. Mocks
 * generateCookingStepsForFixedIngredients so this never makes a real
 * OpenAI call.
 */

const { connectTestDb, disconnectTestDb, clearTestDb } = require('./helpers/testDb');

jest.mock('../utils/supabaseAuth');
const { registerTestToken, clearTestTokens } = require('../utils/supabaseAuth');

jest.mock('../utils/openaiClient', () => ({
  generateCookingStepsForFixedIngredients: jest.fn(),
}));
const { generateCookingStepsForFixedIngredients } = require('../utils/openaiClient');

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
  jest.clearAllMocks();
  await clearTestDb();
});

afterAll(async () => {
  await disconnectTestDb();
});

const auth = (req) => req.set('Authorization', 'Bearer dietician-token');

describe('POST .../recipes/backfill-cooking-steps', () => {
  test('dry run: generates steps for every recipe missing instructions without saving them', async () => {
    const dietician = await createDietician();
    registerTestToken('dietician-token', dietician._id);

    const empty = await Recipe.create({
      dieticianId: dietician._id,
      name: 'Baked Besan Pakora',
      servingTime: 'Evening Snack',
      ingredients: [{ name: 'Chickpea Flour', quantity: 50, unit: 'g' }],
      instructions: [],
    });
    await Recipe.create({
      dieticianId: dietician._id,
      name: 'Already Has Steps',
      servingTime: 'Lunch',
      ingredients: [{ name: 'Rice', quantity: 100, unit: 'g' }],
      instructions: ['Cook rice.'],
    });

    generateCookingStepsForFixedIngredients.mockResolvedValue([
      'Preheat the oven to 200°C.',
      'Mix the besan into a batter.',
      'Bake until golden.',
    ]);

    const res = await auth(request(app).post('/api/dietician/recipes/backfill-cooking-steps'));

    expect(res.status).toBe(200);
    expect(res.body.executed).toBe(false);
    expect(res.body.summary).toEqual({ total: 1, updated: 0, failed: 0 });
    expect(res.body.results[0].recipeId).toBe(String(empty._id));
    expect(res.body.results[0].steps).toHaveLength(3);

    const reloaded = await Recipe.findById(empty._id);
    expect(reloaded.instructions).toEqual([]);
  });

  test('?execute=true saves the generated steps onto the recipe', async () => {
    const dietician = await createDietician();
    registerTestToken('dietician-token', dietician._id);

    const empty = await Recipe.create({
      dieticianId: dietician._id,
      name: 'Baked Besan Pakora',
      servingTime: 'Evening Snack',
      ingredients: [{ name: 'Chickpea Flour', quantity: 50, unit: 'g' }],
      instructions: [],
    });

    generateCookingStepsForFixedIngredients.mockResolvedValue(['Preheat the oven.', 'Bake the pakora.']);

    const res = await auth(request(app).post('/api/dietician/recipes/backfill-cooking-steps?execute=true'));

    expect(res.status).toBe(200);
    expect(res.body.executed).toBe(true);
    expect(res.body.summary).toEqual({ total: 1, updated: 1, failed: 0 });

    const reloaded = await Recipe.findById(empty._id);
    expect(reloaded.instructions).toEqual(['Preheat the oven.', 'Bake the pakora.']);
  });

  test('401s without a token', async () => {
    const res = await request(app).post('/api/dietician/recipes/backfill-cooking-steps');
    expect(res.status).toBe(401);
  });
});
