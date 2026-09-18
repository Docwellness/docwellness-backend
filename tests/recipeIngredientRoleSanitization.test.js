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

// Mongoose auto-adds an `_id` to each `components` subdocument - strip it so
// assertions can compare against plain {label, quantity, unit} fixtures.
const stripIds = (arr) => (arr || []).map(({ label, quantity, unit }) => ({ label, quantity, unit }));

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

// unify-recipe-ingredients-and-components: updateRecipe's PATCH path uses
// findOneAndUpdate, which bypasses Recipe.js's pre-save hook entirely - the
// same components-derivation logic has to work here too, not just on
// .save()/.create().
describe('PATCH /recipes/:id (updateRecipe) - components derivation (findOneAndUpdate bypasses the pre-save hook)', () => {
  test('editing ingredients on a derivable recipe (all components match ingredient names) re-derives components server-side', async () => {
    const dietician = await createDietician();
    registerTestToken('dietician-token', dietician._id);
    const recipe = await Recipe.create({
      dieticianId: dietician._id,
      name: 'Warm Water with Dates, Figs, Almonds, Walnuts',
      servingTime: 'Morning Drink',
      components: [
        { label: 'Dates', quantity: 1, unit: 'nos' },
        { label: 'Figs', quantity: 1, unit: 'nos' },
      ],
      ingredients: [
        { name: 'Dates', quantity: 1, unit: 'nos', role: 'core' },
        { name: 'Figs', quantity: 1, unit: 'nos', role: 'core' },
      ],
    });

    // Dietician edits ingredients via "Update AI Inputs" - adds the
    // previously-missing Almonds/Walnuts as core, Water as sub - and the
    // request only sends `ingredients`, no `components` key at all (the
    // real shape updateRecipeFromEdits's preview response produces).
    const res = await auth(request(app).patch(`/api/dietician/recipes/${recipe._id}`)).send({
      ingredients: [
        { name: 'Dates', quantity: 1, unit: 'nos', role: 'core' },
        { name: 'Figs', quantity: 1, unit: 'nos', role: 'core' },
        { name: 'Almonds', quantity: 2, unit: 'nos', role: 'core' },
        { name: 'Walnuts', quantity: 2, unit: 'nos', role: 'core' },
        { name: 'Water', quantity: 250, unit: 'ml', role: 'sub' },
      ],
    });

    expect(res.status).toBe(200);
    expect(stripIds(res.body.data.components)).toEqual([
      { label: 'Dates', quantity: 1, unit: 'nos' },
      { label: 'Figs', quantity: 1, unit: 'nos' },
      { label: 'Almonds', quantity: 2, unit: 'nos' },
      { label: 'Walnuts', quantity: 2, unit: 'nos' },
    ]);
    const saved = await Recipe.findById(recipe._id).lean();
    expect(stripIds(saved.components)).toEqual(stripIds(res.body.data.components));
    expect(saved.servingSize).toEqual({ quantity: 1, unit: 'nos' });
  });

  test('editing ingredients on a non-derivable recipe (dish-name component) leaves components untouched', async () => {
    const dietician = await createDietician();
    registerTestToken('dietician-token', dietician._id);
    const recipe = await Recipe.create({
      dieticianId: dietician._id,
      name: 'Oats Porridge',
      servingTime: 'Breakfast',
      components: [{ label: 'Oats Porridge', quantity: 100, unit: 'g' }],
      ingredients: [{ name: 'Oats', quantity: 100, unit: 'g', role: 'core' }],
    });

    const res = await auth(request(app).patch(`/api/dietician/recipes/${recipe._id}`)).send({
      ingredients: [{ name: 'Oats', quantity: 120, unit: 'g', role: 'core' }],
    });

    expect(res.status).toBe(200);
    expect(stripIds(res.body.data.components)).toEqual([{ label: 'Oats Porridge', quantity: 100, unit: 'g' }]);
  });

  test('submitting non-matching components alongside ingredients marks the recipe manually-authored', async () => {
    const dietician = await createDietician();
    registerTestToken('dietician-token', dietician._id);
    const recipe = await Recipe.create({
      dieticianId: dietician._id,
      name: 'Pithla Bhakri',
      servingTime: 'Lunch',
      ingredients: [
        { name: 'Besan', quantity: 50, unit: 'g', role: 'core' },
        { name: 'Jowar Flour', quantity: 80, unit: 'g', role: 'core' },
      ],
    });

    const res = await auth(request(app).patch(`/api/dietician/recipes/${recipe._id}`)).send({
      components: [
        { label: 'Pithla', quantity: 1, unit: 'bowl' },
        { label: 'Bhakri', quantity: 2, unit: 'piece' },
      ],
    });

    expect(res.status).toBe(200);
    expect(stripIds(res.body.data.components)).toEqual([
      { label: 'Pithla', quantity: 1, unit: 'bowl' },
      { label: 'Bhakri', quantity: 2, unit: 'piece' },
    ]);
    const saved = await Recipe.findById(recipe._id).lean();
    expect(saved.componentsAuthoredManually).toBe(true);

    // A later ingredient-only edit must NOT overwrite the manually-authored components.
    const res2 = await auth(request(app).patch(`/api/dietician/recipes/${recipe._id}`)).send({
      ingredients: [
        { name: 'Besan', quantity: 60, unit: 'g', role: 'core' },
        { name: 'Jowar Flour', quantity: 80, unit: 'g', role: 'core' },
      ],
    });
    expect(res2.status).toBe(200);
    expect(stripIds(res2.body.data.components)).toEqual([
      { label: 'Pithla', quantity: 1, unit: 'bowl' },
      { label: 'Bhakri', quantity: 2, unit: 'piece' },
    ]);
  });
});
