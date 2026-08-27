/**
 * recipe-core-ingredient-scaling's manual-authoring path: createRecipe/
 * updateRecipe (controllers/dietician/uploadRecipieController.js's shared
 * sanitizeRecipeIngredients) sanitize each ingredient's `role` and
 * deterministically default the core ingredient group (via
 * utils/coreIngredientHeuristic.js) whenever a dietician's submitted list
 * has zero ingredients marked 'core' - never overriding an explicit
 * single- or multi-core designation.
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

const chapatiIngredients = () => [
  { name: 'Whole Wheat Flour', quantity: 100, unit: 'g', category: 'Carbohydrate' },
  { name: 'Water', quantity: 60, unit: 'ml', category: 'Other' },
  { name: 'Salt', quantity: 1, unit: 'tsp', category: 'Spice' },
];

const mixedVegetableIngredients = (roleOverride) => [
  { name: 'Carrot', quantity: 40, unit: 'g', category: 'Vegetable', role: roleOverride },
  { name: 'Peas', quantity: 40, unit: 'g', category: 'Vegetable', role: roleOverride },
  { name: 'Beans', quantity: 40, unit: 'g', category: 'Vegetable', role: roleOverride },
  { name: 'Oil', quantity: 5, unit: 'g', category: 'Oil/Fat' },
];

describe('POST /recipes (createRecipe) - core/sub ingredient role', () => {
  test('zero-core payload: the category-priority heuristic fills in the core ingredient', async () => {
    const dietician = await createDietician();
    registerTestToken('dietician-token', dietician._id);

    const res = await auth(request(app).post('/api/dietician/recipes')).send({
      name: 'Chapati',
      servingTime: 'Lunch',
      servings: 1,
      ingredients: chapatiIngredients(), // no `role` on any ingredient
    });

    expect(res.status).toBe(201);
    const byName = Object.fromEntries(res.body.data.ingredients.map((i) => [i.name, i.role]));
    expect(byName['Whole Wheat Flour']).toBe('core');
    expect(byName['Water']).toBe('sub');
    expect(byName['Salt']).toBe('sub');

    const saved = await Recipe.findById(res.body.data._id ?? res.body.data.id);
    expect(saved.ingredients.find((i) => i.name === 'Whole Wheat Flour').role).toBe('core');
  });

  test('explicit single-core payload is honored as-is', async () => {
    const dietician = await createDietician();
    registerTestToken('dietician-token', dietician._id);

    const res = await auth(request(app).post('/api/dietician/recipes')).send({
      name: 'Chapati',
      servingTime: 'Lunch',
      servings: 1,
      ingredients: chapatiIngredients().map((ing) => ({ ...ing, role: ing.name === 'Whole Wheat Flour' ? 'core' : 'sub' })),
    });

    expect(res.status).toBe(201);
    const byName = Object.fromEntries(res.body.data.ingredients.map((i) => [i.name, i.role]));
    expect(byName).toEqual({ 'Whole Wheat Flour': 'core', Water: 'sub', Salt: 'sub' });
  });

  test('explicit multi-core payload (Mixed Vegetable-style) is honored as-is, not collapsed to one', async () => {
    const dietician = await createDietician();
    registerTestToken('dietician-token', dietician._id);

    const res = await auth(request(app).post('/api/dietician/recipes')).send({
      name: 'Mixed Vegetable',
      servingTime: 'Lunch',
      servings: 1,
      ingredients: mixedVegetableIngredients('core'),
    });

    expect(res.status).toBe(201);
    const byName = Object.fromEntries(res.body.data.ingredients.map((i) => [i.name, i.role]));
    expect(byName).toEqual({ Carrot: 'core', Peas: 'core', Beans: 'core', Oil: 'sub' });
  });
});

describe('PATCH /recipes/:id (updateRecipe) - core/sub ingredient role', () => {
  test('zero-core ingredients update triggers the same heuristic default', async () => {
    const dietician = await createDietician();
    registerTestToken('dietician-token', dietician._id);
    const recipe = await Recipe.create({
      dieticianId: dietician._id,
      name: 'Chapati',
      servingTime: 'Lunch',
      ingredients: chapatiIngredients(),
    });

    const res = await auth(request(app).patch(`/api/dietician/recipes/${recipe._id}`)).send({
      ingredients: chapatiIngredients(), // still no role
    });

    expect(res.status).toBe(200);
    const saved = await Recipe.findById(recipe._id);
    expect(saved.ingredients.find((i) => i.name === 'Whole Wheat Flour').role).toBe('core');
  });

  test('updating an unrelated field (not touching ingredients) does not require or alter role', async () => {
    const dietician = await createDietician();
    registerTestToken('dietician-token', dietician._id);
    const recipe = await Recipe.create({
      dieticianId: dietician._id,
      name: 'Chapati',
      servingTime: 'Lunch',
      ingredients: chapatiIngredients(), // still unmigrated - no role marked
    });

    const res = await auth(request(app).patch(`/api/dietician/recipes/${recipe._id}`)).send({
      description: 'A simple flatbread.',
    });

    expect(res.status).toBe(200);
    const saved = await Recipe.findById(recipe._id);
    expect(saved.ingredients.every((i) => i.role === undefined || i.role === 'sub')).toBe(true);
  });
});
