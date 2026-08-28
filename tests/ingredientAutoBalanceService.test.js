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

// A countable-serving recipe: Chapati, served in pieces, one core
// ingredient (flour). ~200 cal at 50g flour + 5g ghee.
async function makeCountableVersion({ flourQty = 50, gheeQty = 5, pieces = 1 } = {}) {
  const flour = await FoodItem.findOneAndUpdate(
    { normalizedName: 'wholewheatflour' },
    { $setOnInsert: { name: 'Whole Wheat Flour', normalizedName: 'wholewheatflour', nutritionPer100g: { calories: 340, protein: 13, carbs: 72, fats: 2, fiber: 11 } } },
    { upsert: true, returnDocument: 'after' }
  );
  const ghee = await FoodItem.findOneAndUpdate(
    { normalizedName: 'ghee' },
    { $setOnInsert: { name: 'Ghee', normalizedName: 'ghee', nutritionPer100g: { calories: 900, protein: 0, carbs: 0, fats: 100, fiber: 0 } } },
    { upsert: true, returnDocument: 'after' }
  );
  const calories = (flourQty / 100) * 340 + (gheeQty / 100) * 900;
  const version = await RecipeVersion.create({
    name: 'Chapati',
    parentRecipeId: new mongoose.Types.ObjectId(),
    versionNumber: 1,
    ingredients: [
      { foodItemId: flour._id, rawQuantity: flourQty, unit: 'g', role: 'core' },
      { foodItemId: ghee._id, rawQuantity: gheeQty, unit: 'g', role: 'sub' },
    ],
    components: [{ label: 'Chapati', quantity: pieces, unit: 'piece' }],
    nutritionPerServing: { calories, protein: null, carbs: null, fats: null, fiber: null },
    status: 'Active',
  });
  return { version, flour, ghee };
}

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

  test('clamps the scale ratio instead of producing an unrealistic quantity for an extreme target', async () => {
    const { version } = await makeVersion({ oatsQty: 40, milkQty: 200 }); // 239.6 cal
    const targetCalories = 239.6 * 10; // 10x current - way beyond the 3x clamp

    const newVersion = await autoBalanceIngredients(version._id, targetCalories);

    const oatsIngredient = newVersion.ingredients.find((i) => String(i.foodItemId) === String(version.ingredients[0].foodItemId));
    expect(oatsIngredient.rawQuantity).toBeCloseTo(40 * 3); // capped at 3x, not 10x
    expect(newVersion._wasScaleClamped).toBe(true);
    expect(newVersion.nutritionPerServing.calories).toBeLessThan(targetCalories); // target deliberately undershot
  });

  test('does not flag clamping when the target is reachable within the 3x bound', async () => {
    const { version } = await makeVersion({ oatsQty: 40, milkQty: 200 }); // 239.6 cal
    const newVersion = await autoBalanceIngredients(version._id, 479.2); // exactly 2x, within bound

    expect(newVersion._wasScaleClamped).toBe(false);
  });

  test('floors a countable serving at 1 piece instead of scaling it down to a fraction', async () => {
    const { version } = await makeCountableVersion({ flourQty: 50, gheeQty: 5 }); // 170 + 45 = 215 cal, 1 piece
    // Target ~0.58x current would naively give ~0.58 piece.
    const newVersion = await autoBalanceIngredients(version._id, 215 * 0.58);

    expect(newVersion.components[0].quantity).toBeCloseTo(1, 1);
    expect(newVersion._flooredTo).toBe(1);
    // Ingredients moved by the floored ratio (1/1), not the requested 0.58.
    const flourIngredient = newVersion.ingredients.find((i) => i.role === 'core');
    expect(flourIngredient.rawQuantity).toBeCloseTo(50, 0);
  });

  test('snaps a countable serving to a 0.5 step when scaling up', async () => {
    const { version } = await makeCountableVersion({ flourQty: 50, gheeQty: 5 }); // 215 cal, 1 piece
    // ~1.7x current -> naive 1.7 piece -> snaps to 1.5.
    const newVersion = await autoBalanceIngredients(version._id, 215 * 1.7);

    expect(newVersion.components[0].quantity).toBeCloseTo(1.5, 1);
    expect(newVersion._flooredTo).toBe(1.5);
  });

  test('leaves a continuous serving free to scale to any fraction', async () => {
    const { version } = await makeVersion({ oatsQty: 40, milkQty: 200 }); // 239.6 cal, no components
    const newVersion = await autoBalanceIngredients(version._id, 239.6 * 0.6);

    expect(newVersion._flooredTo).toBeNull();
    expect(newVersion.nutritionPerServing.calories).toBeCloseTo(239.6 * 0.6, 0);
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

  test('skips pinned items entirely, rebalancing the rest around them', async () => {
    const { dayPlan, breakfastItem, lunchItem } = await makeDayWithTwoItems();
    breakfastItem.pinned = true;
    await breakfastItem.save();
    const pinnedVersionId = String(breakfastItem.recipeVersionId);

    await autoBalanceDay(dayPlan._id, 1437.6);

    const breakfastAfter = await PlanItem.findById(breakfastItem._id);
    expect(String(breakfastAfter.recipeVersionId)).toBe(pinnedVersionId); // untouched
    const lunchAfter = await PlanItem.findById(lunchItem._id);
    expect(String(lunchAfter.recipeVersionId)).not.toBe(String(lunchItem.recipeVersionId)); // rebalanced
    // lunch should absorb the whole remaining budget: 1437.6 - 239.6 = 1198
    expect(lunchAfter.calculatedNutrition.calories).toBeCloseTo(1198, -1);
  });

  describe('countable/continuous partition (portion realism)', () => {
    async function makeDayWithChapatiAndTwoDals() {
      const patientId = new mongoose.Types.ObjectId();
      const dieticianId = new mongoose.Types.ObjectId();
      const dietPlan = await DietPlan.create({ patientId, dieticianId, dataModel: 'plan-item' });
      const dayPlan = await DayPlan.create({ dietPlanId: dietPlan._id, patientId, week: 1, dayGroup: 'Monday' });
      const lunchSlot = await MealSlotPlan.create({ dayPlanId: dayPlan._id, servingTime: 'Lunch' });
      const dinnerSlot = await MealSlotPlan.create({ dayPlanId: dayPlan._id, servingTime: 'Dinner' });

      const { version: chapati } = await makeCountableVersion({ flourQty: 50, gheeQty: 5 }); // ~215 cal, 1 piece
      const { version: dal1 } = await makeVersion({ oatsQty: 60, milkQty: 100 }); // continuous
      const { version: dal2 } = await makeVersion({ oatsQty: 60, milkQty: 100 });

      const chapatiItem = await PlanItem.create({ mealSlotId: lunchSlot._id, recipeVersionId: chapati._id, calculatedNutrition: chapati.nutritionPerServing });
      const dal1Item = await PlanItem.create({ mealSlotId: lunchSlot._id, recipeVersionId: dal1._id, calculatedNutrition: dal1.nutritionPerServing });
      const dal2Item = await PlanItem.create({ mealSlotId: dinnerSlot._id, recipeVersionId: dal2._id, calculatedNutrition: dal2.nutritionPerServing });

      return { dayPlan, chapatiItem, dal1Item, dal2Item, chapatiCal: chapati.nutritionPerServing.calories };
    }

    test('floors the Chapati at 1 piece and lets the dals absorb the difference toward target', async () => {
      const { dayPlan, chapatiItem, dal1Item, dal2Item } = await makeDayWithChapatiAndTwoDals();
      // Small day target so the Chapati's proportional share would be well under 1 piece.
      const target = 700;

      await autoBalanceDay(dayPlan._id, target);

      const chapatiAfter = await PlanItem.findById(chapatiItem._id);
      const chapatiVersion = await RecipeVersion.findById(chapatiAfter.recipeVersionId);
      expect(chapatiVersion.components[0].quantity).toBeGreaterThanOrEqual(1);

      const dal1After = await PlanItem.findById(dal1Item._id);
      const dal2After = await PlanItem.findById(dal2Item._id);
      const dayTotal =
        chapatiAfter.calculatedNutrition.calories + dal1After.calculatedNutrition.calories + dal2After.calculatedNutrition.calories;
      // Within ~10% of target - the dals soaked up the floored Chapati calories.
      expect(Math.abs(dayTotal - target) / target).toBeLessThan(0.1);
    });

    test('a day of only countable items keeps the snapped portions and does not throw', async () => {
      const patientId = new mongoose.Types.ObjectId();
      const dietPlan = await DietPlan.create({ patientId, dieticianId: new mongoose.Types.ObjectId(), dataModel: 'plan-item' });
      const dayPlan = await DayPlan.create({ dietPlanId: dietPlan._id, patientId, week: 1, dayGroup: 'Monday' });
      const lunchSlot = await MealSlotPlan.create({ dayPlanId: dayPlan._id, servingTime: 'Lunch' });
      const { version: chapati1 } = await makeCountableVersion({ flourQty: 50, gheeQty: 5 });
      const { version: chapati2 } = await makeCountableVersion({ flourQty: 50, gheeQty: 5 });
      const item1 = await PlanItem.create({ mealSlotId: lunchSlot._id, recipeVersionId: chapati1._id, calculatedNutrition: chapati1.nutritionPerServing });
      const item2 = await PlanItem.create({ mealSlotId: lunchSlot._id, recipeVersionId: chapati2._id, calculatedNutrition: chapati2.nutritionPerServing });

      await expect(autoBalanceDay(dayPlan._id, 200)).resolves.toBeDefined(); // no throw, no infinite adjust

      for (const id of [item1._id, item2._id]) {
        const after = await PlanItem.findById(id);
        const version = await RecipeVersion.findById(after.recipeVersionId);
        expect(version.components[0].quantity).toBeGreaterThanOrEqual(1);
        expect(version.components[0].quantity * 2).toBe(Math.round(version.components[0].quantity * 2)); // on a 0.5 step
      }
    });
  });
});
