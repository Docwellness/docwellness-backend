/**
 * fill-recipe-micronutrients: PATCH /api/dietician/recipes/:id (updateRecipe)
 * writes `nutrition` as dotted paths, so a save that carries only some keys
 * (the dietician app's macros-only save) leaves the omitted ones - notably the
 * nine micronutrients - untouched instead of replacing the whole subdocument.
 */
const { connectTestDb, disconnectTestDb, clearTestDb } = require('./helpers/testDb');

jest.mock('../utils/supabaseAuth');
const { registerTestToken, clearTestTokens } = require('../utils/supabaseAuth');

let request;
let app;
let createDietician;
let Recipe;
let recipeVersioningService;

beforeAll(async () => {
  await connectTestDb();
  request = require('supertest');
  app = require('../config/createApp')();
  ({ createDietician } = require('./helpers/factories'));
  ({ Recipe } = require('../models'));
  recipeVersioningService = require('../services/recipeVersioningService');
});

afterEach(async () => {
  clearTestTokens();
  await clearTestDb();
});

afterAll(async () => {
  await disconnectTestDb();
});

const patchRecipe = (recipe, body) =>
  request(app)
    .patch(`/api/dietician/recipes/${recipe._id}`)
    .set('Authorization', 'Bearer dietician-token')
    .send(body);

const createRecipeWithNutrition = async () => {
  const dietician = await createDietician();
  registerTestToken('dietician-token', dietician._id);
  return Recipe.create({
    dieticianId: dietician._id,
    name: 'Chana Chaat',
    servingTime: 'Lunch',
    ingredients: [{ name: 'Chickpeas', quantity: 100, unit: 'g', category: 'Carbohydrate' }],
    nutrition: {
      calories: 200,
      protein: 10,
      carbs: 30,
      fats: 4,
      fiber: 6,
      saturatedFat: 1.2,
      sodium: 340,
      iron: 2.5,
      vitaminC: 8,
    },
  });
};

describe('PATCH /recipes/:id (updateRecipe) - nutrition is merged, not replaced', () => {
  test('a macros-only nutrition save leaves the existing micronutrients intact', async () => {
    const recipe = await createRecipeWithNutrition();

    const res = await patchRecipe(recipe, {
      nutrition: { calories: 250, protein: 12, carbs: 35, fats: 5, fiber: 7 },
    });

    expect(res.status).toBe(200);
    const saved = await Recipe.findById(recipe._id).lean();
    expect(saved.nutrition).toMatchObject({
      calories: 250,
      protein: 12,
      carbs: 35,
      fats: 5,
      fiber: 7,
      saturatedFat: 1.2,
      sodium: 340,
      iron: 2.5,
      vitaminC: 8,
    });
  });

  test('a payload carrying micronutrients updates them and leaves the rest alone', async () => {
    const recipe = await createRecipeWithNutrition();

    const res = await patchRecipe(recipe, { nutrition: { sodium: 400, calcium: 55 } });

    expect(res.status).toBe(200);
    const saved = await Recipe.findById(recipe._id).lean();
    expect(saved.nutrition).toMatchObject({
      calories: 200,
      sodium: 400,
      calcium: 55,
      iron: 2.5,
    });
  });

  test('an explicit null sets that micronutrient to null', async () => {
    const recipe = await createRecipeWithNutrition();

    const res = await patchRecipe(recipe, { nutrition: { iron: null } });

    expect(res.status).toBe(200);
    const saved = await Recipe.findById(recipe._id).lean();
    expect(saved.nutrition.iron).toBeNull();
    expect(saved.nutrition.sodium).toBe(340);
  });

  test('unknown nutrition keys are ignored', async () => {
    const recipe = await createRecipeWithNutrition();

    const res = await patchRecipe(recipe, { nutrition: { calories: 210, bogus: 5 } });

    expect(res.status).toBe(200);
    const saved = await Recipe.findById(recipe._id).lean();
    expect(saved.nutrition.calories).toBe(210);
    expect(saved.nutrition).not.toHaveProperty('bogus');
  });

  test('other direct fields still update alongside nutrition', async () => {
    const recipe = await createRecipeWithNutrition();

    const res = await patchRecipe(recipe, {
      image: 'https://example.com/chaat.jpg',
      servings: 2,
      nutrition: { calories: 220 },
    });

    expect(res.status).toBe(200);
    const saved = await Recipe.findById(recipe._id).lean();
    expect(saved.image).toBe('https://example.com/chaat.jpg');
    expect(saved.imageSource).toBe('dietician-uploaded');
    expect(saved.servings).toBe(2);
    expect(saved.nutrition.calories).toBe(220);
    expect(saved.nutrition.iron).toBe(2.5);
  });

  test('nutrition {} alone is rejected as nothing to update', async () => {
    const recipe = await createRecipeWithNutrition();

    const res = await patchRecipe(recipe, { nutrition: {} });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('No updatable fields provided');
    const saved = await Recipe.findById(recipe._id).lean();
    expect(saved.nutrition).toMatchObject({ calories: 200, sodium: 340 });
  });

  test('a null nutrition is set whole, as before (the nine go with it)', async () => {
    const recipe = await createRecipeWithNutrition();

    const res = await patchRecipe(recipe, { nutrition: null });

    expect(res.status).toBe(200);
    const saved = await Recipe.findById(recipe._id).lean();
    expect(saved.nutrition?.sodium ?? null).toBeNull();
    expect(saved.nutrition?.calories ?? null).toBeNull();
  });

  test('an array nutrition is set whole, as before (not merged key by key)', async () => {
    const recipe = await createRecipeWithNutrition();

    const res = await patchRecipe(recipe, { nutrition: [1, 2] });

    expect(res.status).toBe(200);
    const saved = await Recipe.findById(recipe._id).lean();
    expect(saved.nutrition).toEqual([1, 2]);
  });

  test('a numeric string is cast to a number by the schema', async () => {
    const recipe = await createRecipeWithNutrition();

    const res = await patchRecipe(recipe, { nutrition: { sodium: '410' } });

    expect(res.status).toBe(200);
    const saved = await Recipe.findById(recipe._id).lean();
    expect(saved.nutrition.sodium).toBe(410);
  });

  test('a non-numeric string is rejected and nothing is written', async () => {
    const recipe = await createRecipeWithNutrition();

    const res = await patchRecipe(recipe, { nutrition: { sodium: 'lots', calories: 999 } });

    expect(res.status).toBeGreaterThanOrEqual(400);
    const saved = await Recipe.findById(recipe._id).lean();
    expect(saved.nutrition).toMatchObject({ calories: 200, sodium: 340 });
  });

  test('a negative value is accepted, as the schema has no minimum', async () => {
    const recipe = await createRecipeWithNutrition();

    const res = await patchRecipe(recipe, { nutrition: { sodium: -5 } });

    expect(res.status).toBe(200);
    const saved = await Recipe.findById(recipe._id).lean();
    expect(saved.nutrition.sodium).toBe(-5);
  });

  test("another dietician's recipe is a 404 and nothing is written", async () => {
    const owner = await createDietician();
    const recipe = await Recipe.create({
      dieticianId: owner._id,
      name: 'Not Yours',
      servingTime: 'Lunch',
      ingredients: [{ name: 'Rice', quantity: 100, unit: 'g', category: 'Carbohydrate' }],
      nutrition: { calories: 200, sodium: 340 },
    });
    const other = await createDietician();
    registerTestToken('dietician-token', other._id);

    const res = await patchRecipe(recipe, { nutrition: { calories: 1, sodium: 1 } });

    expect(res.status).toBe(404);
    const saved = await Recipe.findById(recipe._id).lean();
    expect(saved.nutrition).toMatchObject({ calories: 200, sodium: 340 });
  });

  test('the V1 RecipeVersion sync runs with the updated recipe after a nutrition change', async () => {
    const recipe = await createRecipeWithNutrition();
    const syncSpy = jest
      .spyOn(recipeVersioningService, 'syncV1FromRecipe')
      .mockResolvedValue(undefined);

    try {
      const res = await patchRecipe(recipe, { nutrition: { calories: 260 } });

      expect(res.status).toBe(200);
      expect(syncSpy).toHaveBeenCalledTimes(1);
      const synced = syncSpy.mock.calls[0][0];
      expect(String(synced._id)).toBe(String(recipe._id));
      expect(synced.nutrition.calories).toBe(260);
    } finally {
      syncSpy.mockRestore();
    }
  });
});

describe('PATCH /recipes/:id (updateRecipe) - an ingredients change invalidates stale micronutrients', () => {
  const newIngredients = [{ name: 'Rice', quantity: 80, unit: 'g', category: 'Carbohydrate' }];
  const MICRO_KEYS = [
    'saturatedFat',
    'transFat',
    'sugar',
    'cholesterol',
    'sodium',
    'calcium',
    'iron',
    'potassium',
    'vitaminC',
  ];

  test('ingredients plus macros-only nutrition nulls every micronutrient', async () => {
    const recipe = await createRecipeWithNutrition();

    const res = await patchRecipe(recipe, {
      ingredients: newIngredients,
      nutrition: { calories: 300, protein: 8, carbs: 50, fats: 3, fiber: 2 },
    });

    expect(res.status).toBe(200);
    const saved = await Recipe.findById(recipe._id).lean();
    expect(saved.nutrition).toMatchObject({ calories: 300, protein: 8, carbs: 50, fats: 3, fiber: 2 });
    for (const key of MICRO_KEYS) {
      expect(saved.nutrition[key]).toBeNull();
    }
  });

  test('ingredients without any nutrition also nulls the micronutrients and keeps the macros', async () => {
    const recipe = await createRecipeWithNutrition();

    const res = await patchRecipe(recipe, { ingredients: newIngredients });

    expect(res.status).toBe(200);
    const saved = await Recipe.findById(recipe._id).lean();
    expect(saved.nutrition.calories).toBe(200);
    for (const key of MICRO_KEYS) {
      expect(saved.nutrition[key]).toBeNull();
    }
  });

  test('a micronutrient carried in the payload keeps its value; the others are nulled', async () => {
    const recipe = await createRecipeWithNutrition();

    const res = await patchRecipe(recipe, {
      ingredients: newIngredients,
      nutrition: { calories: 300, sodium: 120, iron: null },
    });

    expect(res.status).toBe(200);
    const saved = await Recipe.findById(recipe._id).lean();
    expect(saved.nutrition.sodium).toBe(120);
    expect(saved.nutrition.iron).toBeNull();
    expect(saved.nutrition.vitaminC).toBeNull();
    expect(saved.nutrition.saturatedFat).toBeNull();
  });

  test('without an ingredients change the micronutrients stay untouched', async () => {
    const recipe = await createRecipeWithNutrition();

    const res = await patchRecipe(recipe, { nutrition: { calories: 300 }, servings: 3 });

    expect(res.status).toBe(200);
    const saved = await Recipe.findById(recipe._id).lean();
    expect(saved.nutrition).toMatchObject({ saturatedFat: 1.2, sodium: 340, iron: 2.5, vitaminC: 8 });
  });

  test('resending identical ingredients with macros-only nutrition keeps all nine (Save Recipe)', async () => {
    const recipe = await createRecipeWithNutrition();

    const res = await patchRecipe(recipe, {
      ingredients: [{ name: ' chickpeas ', quantity: '100', unit: 'g', category: 'Carbohydrate' }],
      nutrition: { calories: 210, protein: 11, carbs: 31, fats: 4, fiber: 6 },
      servings: 2,
    });

    expect(res.status).toBe(200);
    const saved = await Recipe.findById(recipe._id).lean();
    expect(saved.nutrition).toMatchObject({
      calories: 210,
      saturatedFat: 1.2,
      sodium: 340,
      iron: 2.5,
      vitaminC: 8,
    });
  });

  test('re-ordering the same ingredients is not a change', async () => {
    const dietician = await createDietician();
    registerTestToken('dietician-token', dietician._id);
    const recipe = await Recipe.create({
      dieticianId: dietician._id,
      name: 'Rice Bowl',
      servingTime: 'Lunch',
      ingredients: [
        { name: 'Rice', quantity: 100, unit: 'g', category: 'Carbohydrate' },
        { name: 'Dal', quantity: 50, unit: 'g', category: 'Legume' },
      ],
      nutrition: { calories: 200, sodium: 340 },
    });

    const res = await patchRecipe(recipe, {
      ingredients: [
        { name: 'Dal', quantity: 50, unit: 'g', category: 'Legume' },
        { name: 'Rice', quantity: 100, unit: 'g', category: 'Carbohydrate' },
      ],
    });

    expect(res.status).toBe(200);
    const saved = await Recipe.findById(recipe._id).lean();
    expect(saved.nutrition.sodium).toBe(340);
  });

  describe.each([
    ['a changed quantity', [{ name: 'Chickpeas', quantity: 150, unit: 'g', category: 'Carbohydrate' }]],
    ['a changed unit', [{ name: 'Chickpeas', quantity: 100, unit: 'ml', category: 'Carbohydrate' }]],
    ['a changed name', [{ name: 'Black chickpeas', quantity: 100, unit: 'g', category: 'Carbohydrate' }]],
    [
      'an added ingredient',
      [
        { name: 'Chickpeas', quantity: 100, unit: 'g', category: 'Carbohydrate' },
        { name: 'Onion', quantity: 20, unit: 'g', category: 'Vegetable' },
      ],
    ],
    ['a removed ingredient', []],
  ])('%s', (_label, ingredients) => {
    test('nulls the micronutrients the request does not carry', async () => {
      const recipe = await createRecipeWithNutrition();

      const res = await patchRecipe(recipe, {
        ingredients,
        nutrition: { calories: 300, protein: 8, carbs: 50, fats: 3, fiber: 2 },
      });

      expect(res.status).toBe(200);
      const saved = await Recipe.findById(recipe._id).lean();
      expect(saved.nutrition.calories).toBe(300);
      for (const key of MICRO_KEYS) {
        expect(saved.nutrition[key]).toBeNull();
      }
    });
  });

  test('ingredients [] against empty stored ingredients does not null', async () => {
    const dietician = await createDietician();
    registerTestToken('dietician-token', dietician._id);
    const recipe = await Recipe.create({
      dieticianId: dietician._id,
      name: 'Empty',
      servingTime: 'Lunch',
      ingredients: [],
      nutrition: { calories: 200, sodium: 340 },
    });

    const res = await patchRecipe(recipe, { ingredients: [], servings: 2 });

    expect(res.status).toBe(200);
    const saved = await Recipe.findById(recipe._id).lean();
    expect(saved.nutrition.sodium).toBe(340);
  });

  test('a changed ingredient list with nutrition null sets nutrition whole, with no conflicting write', async () => {
    const recipe = await createRecipeWithNutrition();

    const res = await patchRecipe(recipe, { ingredients: newIngredients, nutrition: null });

    expect(res.status).toBe(200);
    const saved = await Recipe.findById(recipe._id).lean();
    expect(saved.ingredients[0].name).toBe('Rice');
    expect(saved.nutrition?.sodium ?? null).toBeNull();
    expect(saved.nutrition?.calories ?? null).toBeNull();
  });

  test('a changed ingredient list with an array nutrition sets it whole, with no conflicting write', async () => {
    const recipe = await createRecipeWithNutrition();

    const res = await patchRecipe(recipe, { ingredients: newIngredients, nutrition: [1, 2] });

    expect(res.status).toBe(200);
    const saved = await Recipe.findById(recipe._id).lean();
    expect(saved.ingredients[0].name).toBe('Rice');
    expect(saved.nutrition).toEqual([1, 2]);
  });

  test('a changed ingredient list with nutrition {} nulls all nine and keeps the macros', async () => {
    const recipe = await createRecipeWithNutrition();

    const res = await patchRecipe(recipe, { ingredients: newIngredients, nutrition: {} });

    expect(res.status).toBe(200);
    const saved = await Recipe.findById(recipe._id).lean();
    expect(saved.nutrition.calories).toBe(200);
    for (const key of MICRO_KEYS) {
      expect(saved.nutrition[key]).toBeNull();
    }
  });
});

describe('PATCH /recipes/:id (updateRecipe) - V1 RecipeVersion sync on an ingredients-only edit', () => {
  test('the sync runs when only ingredients are in the body', async () => {
    const recipe = await createRecipeWithNutrition();
    const syncSpy = jest
      .spyOn(recipeVersioningService, 'syncV1FromRecipe')
      .mockResolvedValue(undefined);

    try {
      const res = await patchRecipe(recipe, {
        ingredients: [{ name: 'Rice', quantity: 80, unit: 'g', category: 'Carbohydrate' }],
      });

      expect(res.status).toBe(200);
      expect(syncSpy).toHaveBeenCalledTimes(1);
      expect(syncSpy.mock.calls[0][0].ingredients[0].name).toBe('Rice');
    } finally {
      syncSpy.mockRestore();
    }
  });

  test('the sync still runs when identical ingredients are resent', async () => {
    const recipe = await createRecipeWithNutrition();
    const syncSpy = jest
      .spyOn(recipeVersioningService, 'syncV1FromRecipe')
      .mockResolvedValue(undefined);

    try {
      const res = await patchRecipe(recipe, {
        ingredients: [{ name: 'Chickpeas', quantity: 100, unit: 'g', category: 'Carbohydrate' }],
      });

      expect(res.status).toBe(200);
      expect(syncSpy).toHaveBeenCalledTimes(1);
    } finally {
      syncSpy.mockRestore();
    }
  });
});
