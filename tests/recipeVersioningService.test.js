/**
 * services/recipeVersioningService.js::createCustomVersion - the explicit
 * user-required coverage: cloning creates a versionNumber:2 doc, nutrition
 * is recalculated accurately from the new raw quantities, and the original
 * V1 is never mutated.
 */

const { connectTestDb, disconnectTestDb, clearTestDb } = require('./helpers/testDb');

jest.mock('../utils/openaiClient', () => ({
  rewriteRecipeStepsForIngredients: jest.fn(),
}));

let mongoose;
let FoodItem;
let RecipeVersion;
let createCustomVersion;
let computeNutritionFromIngredients;
let computeMicronutrientsForVersion;
let rewriteRecipeStepsForIngredients;

beforeAll(async () => {
  await connectTestDb();
  mongoose = require('mongoose');
  ({ FoodItem, RecipeVersion } = require('../models'));
  ({ createCustomVersion, computeNutritionFromIngredients, computeMicronutrientsForVersion } = require('../services/recipeVersioningService'));
  ({ rewriteRecipeStepsForIngredients } = require('../utils/openaiClient'));
});

beforeEach(() => {
  rewriteRecipeStepsForIngredients.mockReset();
});

afterEach(async () => {
  await clearTestDb();
});

afterAll(async () => {
  await disconnectTestDb();
});

async function makeV1() {
  const oats = await FoodItem.create({
    name: 'Oats',
    normalizedName: 'oats',
    nutritionPer100g: { calories: 389, protein: 17, carbs: 66, fats: 7, fiber: 10 },
  });
  const milk = await FoodItem.create({
    name: 'Milk',
    normalizedName: 'milk',
    nutritionPer100g: { calories: 42, protein: 3.4, carbs: 5, fats: 1, fiber: 0 },
  });
  const parentRecipeId = new mongoose.Types.ObjectId();
  const v1 = await RecipeVersion.create({
    name: 'Oats Porridge',
    parentRecipeId,
    versionNumber: 1,
    ingredients: [
      { foodItemId: oats._id, rawQuantity: 40, unit: 'g' },
      { foodItemId: milk._id, rawQuantity: 200, unit: 'g' },
    ],
    steps: ['Boil milk', 'Add oats'],
    components: [{ label: 'Oats Porridge', quantity: 1, unit: 'bowl' }],
    nutritionPerServing: { calories: 40 * 3.89 + 200 * 0.42, protein: 40 * 0.17 + 200 * 0.034, carbs: null, fats: null, fiber: null },
    status: 'Active',
  });
  return { v1, oats, milk, parentRecipeId };
}

describe('createCustomVersion', () => {
  test('creates a new document with versionNumber incremented, never mutating the original', async () => {
    const { v1, oats, milk } = await makeV1();
    const v1Snapshot = v1.toObject();

    const v2 = await createCustomVersion(v1._id, [
      { foodItemId: oats._id, rawQuantity: 50, unit: 'g' },
      { foodItemId: milk._id, rawQuantity: 200, unit: 'g' },
    ]);

    expect(v2.versionNumber).toBe(2);
    expect(String(v2.parentRecipeId)).toBe(String(v1.parentRecipeId));
    expect(String(v2._id)).not.toBe(String(v1._id));

    const v1Reloaded = await RecipeVersion.findById(v1._id);
    expect(v1Reloaded.toObject().ingredients).toEqual(v1Snapshot.ingredients);
    expect(v1Reloaded.toObject().nutritionPerServing).toEqual(v1Snapshot.nutritionPerServing);
  });

  test('recalculates nutritionPerServing accurately from the NEW raw quantities', async () => {
    const { v1, oats, milk } = await makeV1();

    const v2 = await createCustomVersion(v1._id, [
      { foodItemId: oats._id, rawQuantity: 50, unit: 'g' }, // was 40g
      { foodItemId: milk._id, rawQuantity: 250, unit: 'g' }, // was 200g
    ]);

    // 50g oats @ 389/100g = 194.5; 250g milk @ 42/100g = 105 -> 299.5 total
    expect(v2.nutritionPerServing.calories).toBeCloseTo(194.5 + 105);
    // protein: 50*0.17 + 250*0.034 = 8.5 + 8.5 = 17
    expect(v2.nutritionPerServing.protein).toBeCloseTo(17);
    expect(v2.hasUnresolvedIngredients).toBe(false);
  });

  test('scales the real-world serving components proportionally to the calorie change', async () => {
    const { v1, oats, milk } = await makeV1(); // 1 bowl at 155.6+84=239.6 cal

    const v2 = await createCustomVersion(v1._id, [
      { foodItemId: oats._id, rawQuantity: 80, unit: 'g' }, // exactly 2x oats
      { foodItemId: milk._id, rawQuantity: 400, unit: 'g' }, // exactly 2x milk
    ]);

    expect(v2.nutritionPerServing.calories).toBeCloseTo(239.6 * 2, 0);
    const [component] = v2.toObject().components;
    expect(component).toMatchObject({ label: 'Oats Porridge', quantity: 2, unit: 'bowl' }); // 1 bowl -> 2 bowls
  });

  test('leaves components unscaled (ratio 1) when the new calories cannot be resolved', async () => {
    const { v1 } = await makeV1();
    const mystery = await FoodItem.create({ name: 'Mystery Grain', normalizedName: 'mystery-grain', nutritionPer100g: {} }); // no macros

    const v2 = await createCustomVersion(v1._id, [{ foodItemId: mystery._id, rawQuantity: 50, unit: 'g' }]);

    expect(v2.hasUnresolvedIngredients).toBe(true);
    expect(v2.nutritionPerServing.calories).toBeNull();
    const [component] = v2.toObject().components;
    expect(component).toMatchObject({ label: 'Oats Porridge', quantity: 1, unit: 'bowl' }); // unchanged, not silently zeroed
  });

  test('a second edit increments from the LATEST version, not always original+1', async () => {
    const { v1, oats, milk } = await makeV1();
    const v2 = await createCustomVersion(v1._id, [
      { foodItemId: oats._id, rawQuantity: 50, unit: 'g' },
      { foodItemId: milk._id, rawQuantity: 200, unit: 'g' },
    ]);
    const v3 = await createCustomVersion(v2._id, [
      { foodItemId: oats._id, rawQuantity: 60, unit: 'g' },
      { foodItemId: milk._id, rawQuantity: 200, unit: 'g' },
    ]);

    expect(v3.versionNumber).toBe(3);
    const allVersions = await RecipeVersion.find({ parentRecipeId: v1.parentRecipeId }).sort({ versionNumber: 1 });
    expect(allVersions.map((v) => v.versionNumber)).toEqual([1, 2, 3]);
  });

  test('flags unresolved ingredients rather than approximating', async () => {
    const { v1, oats } = await makeV1();
    const unknownFoodItemId = new mongoose.Types.ObjectId();

    const v2 = await createCustomVersion(v1._id, [
      { foodItemId: oats._id, rawQuantity: 40, unit: 'g' },
      { foodItemId: unknownFoodItemId, rawQuantity: 200, unit: 'g' },
    ]);

    expect(v2.hasUnresolvedIngredients).toBe(true);
    expect(v2.unresolvedIngredientNames).toHaveLength(1);
    // Only the resolved (oats) contribution is counted.
    expect(v2.nutritionPerServing.calories).toBeCloseTo(40 * 3.89);
  });

  test('leaves steps untouched and never calls the AI rewrite when regenerateSteps is omitted (default false)', async () => {
    const { v1, oats, milk } = await makeV1();

    const v2 = await createCustomVersion(v1._id, [
      { foodItemId: oats._id, rawQuantity: 50, unit: 'g' },
      { foodItemId: milk._id, rawQuantity: 200, unit: 'g' },
    ]);

    expect(v2.toObject().steps).toEqual(['Boil milk', 'Add oats']);
    expect(rewriteRecipeStepsForIngredients).not.toHaveBeenCalled();
  });

  test('regenerateSteps: true calls the AI rewrite with the new named ingredients and uses its result', async () => {
    const { v1, oats, milk } = await makeV1();
    rewriteRecipeStepsForIngredients.mockResolvedValue(['Boil 200g milk', 'Add 50g oats']);

    const v2 = await createCustomVersion(
      v1._id,
      [
        { foodItemId: oats._id, rawQuantity: 50, unit: 'g' },
        { foodItemId: milk._id, rawQuantity: 200, unit: 'g' },
      ],
      { regenerateSteps: true }
    );

    expect(rewriteRecipeStepsForIngredients).toHaveBeenCalledTimes(1);
    const call = rewriteRecipeStepsForIngredients.mock.calls[0][0];
    expect(call.name).toBe('Oats Porridge');
    expect(call.steps).toEqual(['Boil milk', 'Add oats']);
    expect(call.ingredients).toEqual([
      { name: 'Oats', quantity: 50, unit: 'g' },
      { name: 'Milk', quantity: 200, unit: 'g' },
    ]);
    expect(v2.toObject().steps).toEqual(['Boil 200g milk', 'Add 50g oats']);
  });

  test('regenerateSteps: true is skipped when the original version has no steps to rewrite', async () => {
    const oats = await FoodItem.create({
      name: 'Oats',
      normalizedName: 'oats-2',
      nutritionPer100g: { calories: 389, protein: 17, carbs: 66, fats: 7, fiber: 10 },
    });
    const v1 = await RecipeVersion.create({
      name: 'No-Steps Recipe',
      parentRecipeId: new mongoose.Types.ObjectId(),
      versionNumber: 1,
      ingredients: [{ foodItemId: oats._id, rawQuantity: 40, unit: 'g' }],
      steps: [],
      status: 'Active',
    });

    const v2 = await createCustomVersion(v1._id, [{ foodItemId: oats._id, rawQuantity: 50, unit: 'g' }], {
      regenerateSteps: true,
    });

    expect(rewriteRecipeStepsForIngredients).not.toHaveBeenCalled();
    expect(v2.toObject().steps).toEqual([]);
  });

  test('throws for a non-existent originalVersionId', async () => {
    await expect(createCustomVersion(new mongoose.Types.ObjectId(), [])).rejects.toThrow('not found');
  });

  test('throws for an Archived original version', async () => {
    const { v1, oats } = await makeV1();
    v1.status = 'Archived';
    await v1.save();

    await expect(
      createCustomVersion(v1._id, [{ foodItemId: oats._id, rawQuantity: 40, unit: 'g' }])
    ).rejects.toThrow('not Active');
  });
});

// fill-recipe-micronutrients (openspec): computeNutritionFromIngredients'
// nine new micronutrient fields, summed under a stricter rule than the five
// macros - see design.md Decision 3 and the function's own doc comment.
describe('computeNutritionFromIngredients - micronutrients', () => {
  test('sums a micronutrient across ingredients when every one has a real value for it', async () => {
    const spinach = await FoodItem.create({
      name: 'Spinach',
      normalizedName: 'spinach',
      nutritionPer100g: { calories: 23, protein: 3, carbs: 3, fats: 0, fiber: 2, iron: 2.7, vitaminC: 28 },
    });
    const lemon = await FoodItem.create({
      name: 'Lemon',
      normalizedName: 'lemon',
      nutritionPer100g: { calories: 29, protein: 1, carbs: 9, fats: 0, fiber: 3, iron: 0.6, vitaminC: 53 },
    });
    const foodItemsById = new Map([
      [String(spinach._id), spinach],
      [String(lemon._id), lemon],
    ]);
    const ingredients = [
      { foodItemId: spinach._id, rawQuantity: 100, unit: 'g' },
      { foodItemId: lemon._id, rawQuantity: 50, unit: 'g' },
    ];

    const { nutritionPerServing, micronutrientsIncomplete } = computeNutritionFromIngredients(ingredients, foodItemsById);

    // 100g spinach @ 2.7mg/100g = 2.7; 50g lemon @ 0.6mg/100g = 0.3 -> 3.0
    expect(nutritionPerServing.iron).toBeCloseTo(3.0);
    // 100g spinach @ 28mg/100g = 28; 50g lemon @ 53mg/100g = 26.5 -> 54.5
    expect(nutritionPerServing.vitaminC).toBeCloseTo(54.5);
    expect(micronutrientsIncomplete).not.toContain('iron');
    expect(micronutrientsIncomplete).not.toContain('vitaminC');
  });

  test('strict-null rule: ONE ingredient missing a nutrient makes that nutrient null for the whole recipe, even though every ingredient resolves fine for macros', async () => {
    const spinach = await FoodItem.create({
      name: 'Spinach',
      normalizedName: 'spinach',
      nutritionPer100g: { calories: 23, protein: 3, carbs: 3, fats: 0, fiber: 2, iron: 2.7, vitaminC: 28 },
    });
    // Fully resolved for the five macros, but iron/vitaminC were never
    // researched (still null, the schema default) - matches "a value
    // nobody has looked up yet" from design.md Decision 5, distinct from a
    // verified zero.
    const oil = await FoodItem.create({
      name: 'Oil',
      normalizedName: 'oil',
      nutritionPer100g: { calories: 884, protein: 0, carbs: 0, fats: 100, fiber: 0 },
    });
    const foodItemsById = new Map([
      [String(spinach._id), spinach],
      [String(oil._id), oil],
    ]);
    const ingredients = [
      { foodItemId: spinach._id, rawQuantity: 100, unit: 'g' },
      { foodItemId: oil._id, rawQuantity: 10, unit: 'g' },
    ];

    const { nutritionPerServing, hasUnresolvedIngredients, micronutrientsIncomplete } = computeNutritionFromIngredients(
      ingredients,
      foodItemsById
    );

    // Macros are unaffected by the missing micronutrient data - both
    // ingredients fully resolve for calories/etc, so this must NOT be null.
    expect(nutritionPerServing.calories).toBeCloseTo(23 + 88.4);
    expect(hasUnresolvedIngredients).toBe(false);
    // But iron/vitaminC are strictly null for the whole recipe, because Oil
    // has no researched value for them - a partial sum (spinach's 2.7mg
    // iron alone) would silently understate the real total, which
    // design.md Decision 3 explicitly rejects.
    expect(nutritionPerServing.iron).toBeNull();
    expect(nutritionPerServing.vitaminC).toBeNull();
    expect(micronutrientsIncomplete).toEqual(expect.arrayContaining(['iron', 'vitaminC']));
  });

  test('micronutrient incompleteness never sets hasUnresolvedIngredients (which stays macro-only, per design.md Decision 3, so menuGenerationService is unaffected)', async () => {
    const oil = await FoodItem.create({
      name: 'Oil',
      normalizedName: 'oil-2',
      nutritionPer100g: { calories: 884, protein: 0, carbs: 0, fats: 100, fiber: 0 }, // no micronutrients researched
    });
    const foodItemsById = new Map([[String(oil._id), oil]]);
    const ingredients = [{ foodItemId: oil._id, rawQuantity: 10, unit: 'g' }];

    const { hasUnresolvedIngredients, unresolvedIngredientNames, micronutrientsIncomplete } = computeNutritionFromIngredients(
      ingredients,
      foodItemsById
    );

    expect(hasUnresolvedIngredients).toBe(false);
    expect(unresolvedIngredientNames).toEqual([]);
    expect(micronutrientsIncomplete.length).toBeGreaterThan(0);
  });

  test('a verified-zero micronutrient (a real, researched 0) is summed as 0, not treated as missing', async () => {
    // rule:plant-cholesterol - design.md Decision 5's named rule for
    // dietary cholesterol in purely plant foods.
    const rice = await FoodItem.create({
      name: 'Rice',
      normalizedName: 'rice-zero-test',
      nutritionPer100g: { calories: 130, protein: 2.7, carbs: 28, fats: 0.3, fiber: 0.4, cholesterol: 0 },
    });
    const foodItemsById = new Map([[String(rice._id), rice]]);
    const ingredients = [{ foodItemId: rice._id, rawQuantity: 150, unit: 'g' }];

    const { nutritionPerServing, micronutrientsIncomplete } = computeNutritionFromIngredients(ingredients, foodItemsById);

    expect(nutritionPerServing.cholesterol).toBe(0);
    expect(micronutrientsIncomplete).not.toContain('cholesterol');
  });
});

describe('computeMicronutrientsForVersion', () => {
  test('recomputes only the nine micronutrients from a RecipeVersion\'s own frozen ingredients, independent of its macros', async () => {
    const { v1, oats, milk } = await makeV1();
    // FoodItem micronutrient data researched AFTER v1 was created - this is
    // exactly the prod migration's `versions` phase scenario (design.md
    // Decision 4c): backfilling micronutrients onto an already-frozen,
    // already-prescribed version without touching anything else about it.
    oats.nutritionPer100g.iron = 4.7;
    await oats.save();
    milk.nutritionPer100g.iron = 0.03;
    await milk.save();
    const foodItemsById = new Map([
      [String(oats._id), oats],
      [String(milk._id), milk],
    ]);

    const { micronutrients, micronutrientsIncomplete } = computeMicronutrientsForVersion(v1, foodItemsById);

    // 40g oats @ 4.7mg/100g = 1.88; 200g milk @ 0.03mg/100g = 0.06 -> 1.94
    expect(micronutrients.iron).toBeCloseTo(1.94);
    expect(micronutrientsIncomplete).not.toContain('iron');
    // Untouched: this function returns ONLY the micronutrients object, never
    // macros/ingredients/versionNumber - the caller (the migration script)
    // is what's responsible for a targeted $set on nutritionPerServing.<micro>
    // paths only, never overwriting v1.nutritionPerServing.calories etc.
    expect(micronutrients).not.toHaveProperty('calories');
  });
});
