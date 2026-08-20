/**
 * services/recipeVersioningService.js::createCustomVersion - the explicit
 * user-required coverage: cloning creates a versionNumber:2 doc, nutrition
 * is recalculated accurately from the new raw quantities, and the original
 * V1 is never mutated.
 */

const { connectTestDb, disconnectTestDb, clearTestDb } = require('./helpers/testDb');

let mongoose;
let FoodItem;
let RecipeVersion;
let createCustomVersion;

beforeAll(async () => {
  await connectTestDb();
  mongoose = require('mongoose');
  ({ FoodItem, RecipeVersion } = require('../models'));
  ({ createCustomVersion } = require('../services/recipeVersioningService'));
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
