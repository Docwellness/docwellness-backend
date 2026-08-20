/**
 * services/ingredientAutoBalanceService.js - the explicit user-required
 * coverage: rawQuantity values scaled proportionally.
 */

const { connectTestDb, disconnectTestDb, clearTestDb } = require('./helpers/testDb');

let mongoose;
let FoodItem;
let RecipeVersion;
let DietPlan;
let DayPlan;
let MealSlotPlan;
let PlanItem;
let autoBalanceIngredients;
let autoBalanceDay;
let autoBalanceWeek;

beforeAll(async () => {
  await connectTestDb();
  mongoose = require('mongoose');
  ({ FoodItem, RecipeVersion, DietPlan, DayPlan, MealSlotPlan, PlanItem } = require('../models'));
  ({ autoBalanceIngredients, autoBalanceDay, autoBalanceWeek } = require('../services/ingredientAutoBalanceService'));
});

afterEach(async () => {
  await clearTestDb();
});

afterAll(async () => {
  await disconnectTestDb();
});

async function makeVersion({ oatsQty = 40, milkQty = 200 } = {}) {
  // Real-world: one global 'Oats' FoodItem, not one per RecipeVersion -
  // upsert so multiple calls in the same test share the same document
  // instead of colliding on the unique normalizedName index.
  const oats = await FoodItem.findOneAndUpdate(
    { normalizedName: 'oats' },
    { $setOnInsert: { name: 'Oats', normalizedName: 'oats', nutritionPer100g: { calories: 389, protein: 17, carbs: 66, fats: 7, fiber: 10 } } },
    { upsert: true, returnDocument: 'after' }
  );
  const milk = await FoodItem.findOneAndUpdate(
    { normalizedName: 'milk' },
    { $setOnInsert: { name: 'Milk', normalizedName: 'milk', nutritionPer100g: { calories: 42, protein: 3.4, carbs: 5, fats: 1, fiber: 0 } } },
    { upsert: true, returnDocument: 'after' }
  );
  const calories = (oatsQty / 100) * 389 + (milkQty / 100) * 42;
  const version = await RecipeVersion.create({
    name: 'Oats Porridge',
    parentRecipeId: new mongoose.Types.ObjectId(),
    versionNumber: 1,
    ingredients: [
      { foodItemId: oats._id, rawQuantity: oatsQty, unit: 'g' },
      { foodItemId: milk._id, rawQuantity: milkQty, unit: 'g' },
    ],
    nutritionPerServing: { calories, protein: null, carbs: null, fats: null, fiber: null },
    status: 'Active',
  });
  return { version, oats, milk };
}

describe('autoBalanceIngredients', () => {
  test('scales every ingredient rawQuantity by the same target/current calorie ratio', async () => {
    const { version } = await makeVersion({ oatsQty: 40, milkQty: 200 }); // 155.6 + 84 = 239.6 cal
    const targetCalories = 479.2; // exactly 2x current

    const newVersion = await autoBalanceIngredients(version._id, targetCalories);

    expect(newVersion.versionNumber).toBe(2);
    const oatsIngredient = newVersion.ingredients.find((i) => String(i.foodItemId) === String(version.ingredients[0].foodItemId));
    const milkIngredient = newVersion.ingredients.find((i) => String(i.foodItemId) === String(version.ingredients[1].foodItemId));
    expect(oatsIngredient.rawQuantity).toBeCloseTo(80); // 40 * 2
    expect(milkIngredient.rawQuantity).toBeCloseTo(400); // 200 * 2
    expect(newVersion.nutritionPerServing.calories).toBeCloseTo(targetCalories, 0);
  });

  test('never mutates the original recipeVersionId document', async () => {
    const { version } = await makeVersion();
    const snapshotIngredients = version.toObject().ingredients;

    await autoBalanceIngredients(version._id, 500);

    const reloaded = await RecipeVersion.findById(version._id);
    expect(reloaded.toObject().ingredients).toEqual(snapshotIngredients);
  });

  test('throws when the version has no positive current calories', async () => {
    const { oats, milk } = await makeVersion();
    const emptyVersion = await RecipeVersion.create({
      name: 'Mystery Dish',
      parentRecipeId: new mongoose.Types.ObjectId(),
      versionNumber: 1,
      ingredients: [{ foodItemId: oats._id, rawQuantity: 10, unit: 'g' }],
      nutritionPerServing: { calories: null, protein: null, carbs: null, fats: null, fiber: null },
      status: 'Active',
    });
    await expect(autoBalanceIngredients(emptyVersion._id, 500)).rejects.toThrow('no positive current calories');
  });
});

describe('autoBalanceDay / autoBalanceWeek', () => {
  async function makeDayWithTwoItems() {
    const patientId = new mongoose.Types.ObjectId();
    const dieticianId = new mongoose.Types.ObjectId();
    const dietPlan = await DietPlan.create({ patientId, dieticianId, dataModel: 'plan-item' });
    const dayPlan = await DayPlan.create({ dietPlanId: dietPlan._id, patientId, week: 1, dayGroup: 'Monday' });
    const breakfastSlot = await MealSlotPlan.create({ dayPlanId: dayPlan._id, servingTime: 'Breakfast' });
    const lunchSlot = await MealSlotPlan.create({ dayPlanId: dayPlan._id, servingTime: 'Lunch' });

    const { version: breakfastVersion } = await makeVersion({ oatsQty: 40, milkQty: 200 }); // 239.6 cal
    const { version: lunchVersion } = await makeVersion({ oatsQty: 80, milkQty: 400 }); // 479.2 cal (2x breakfast)

    const breakfastItem = await PlanItem.create({
      mealSlotId: breakfastSlot._id,
      recipeVersionId: breakfastVersion._id,
      calculatedNutrition: breakfastVersion.nutritionPerServing,
    });
    const lunchItem = await PlanItem.create({
      mealSlotId: lunchSlot._id,
      recipeVersionId: lunchVersion._id,
      calculatedNutrition: lunchVersion.nutritionPerServing,
    });

    return { dietPlan, dayPlan, breakfastItem, lunchItem };
  }

  test('distributes the day target proportionally across unlocked items, preserving relative share', async () => {
    const { dayPlan, breakfastItem, lunchItem } = await makeDayWithTwoItems();
    // Current total = 239.6 + 479.2 = 718.8. Target = 1437.6 (exactly 2x) -
    // both items should double, same as the single-item case.
    const results = await autoBalanceDay(dayPlan._id, 1437.6);

    expect(results).toHaveLength(2);
    const breakfastAfter = await PlanItem.findById(breakfastItem._id);
    const lunchAfter = await PlanItem.findById(lunchItem._id);
    expect(breakfastAfter.calculatedNutrition.calories).toBeCloseTo(239.6 * 2, 0);
    expect(lunchAfter.calculatedNutrition.calories).toBeCloseTo(479.2 * 2, 0);
  });

  test('skips locked items entirely', async () => {
    const { dayPlan, breakfastItem, lunchItem } = await makeDayWithTwoItems();
    breakfastItem.locked = true;
    await breakfastItem.save();
    const originalVersionId = String(breakfastItem.recipeVersionId);

    await autoBalanceDay(dayPlan._id, 1437.6);

    const breakfastAfter = await PlanItem.findById(breakfastItem._id);
    expect(String(breakfastAfter.recipeVersionId)).toBe(originalVersionId); // untouched
    const lunchAfter = await PlanItem.findById(lunchItem._id);
    expect(String(lunchAfter.recipeVersionId)).not.toBe(String(lunchItem.recipeVersionId)); // rebalanced
  });

  test('autoBalanceWeek loops every dayGroup for the given week', async () => {
    const { dietPlan, breakfastItem: mondayBreakfast } = await makeDayWithTwoItems();
    const tuesdayDayPlan = await DayPlan.create({ dietPlanId: dietPlan._id, patientId: dietPlan.patientId, week: 1, dayGroup: 'Tuesday' });
    const tuesdaySlot = await MealSlotPlan.create({ dayPlanId: tuesdayDayPlan._id, servingTime: 'Breakfast' });
    const { version: tuesdayVersion } = await makeVersion({ oatsQty: 40, milkQty: 200 });
    await PlanItem.create({
      mealSlotId: tuesdaySlot._id,
      recipeVersionId: tuesdayVersion._id,
      calculatedNutrition: tuesdayVersion.nutritionPerServing,
    });

    const results = await autoBalanceWeek(dietPlan._id, 1, 1437.6);

    const dayGroups = results.map((r) => r.dayGroup).sort();
    expect(dayGroups).toEqual(['Monday', 'Tuesday']);
  });
});
