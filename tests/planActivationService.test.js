/**
 * services/planActivationService.js - the explicit user-required coverage:
 * a passing day and a failing day against the +/-5% activation tolerance.
 */

const { connectTestDb, disconnectTestDb, clearTestDb } = require('./helpers/testDb');

let mongoose;
let FoodItem;
let RecipeVersion;
let DietPlan;
let DayPlan;
let MealSlotPlan;
let PlanItem;
let validatePlanForActivation;

beforeAll(async () => {
  await connectTestDb();
  mongoose = require('mongoose');
  ({ FoodItem, RecipeVersion, DietPlan, DayPlan, MealSlotPlan, PlanItem } = require('../models'));
  ({ validatePlanForActivation } = require('../services/planActivationService'));
});

afterEach(async () => {
  await clearTestDb();
});

afterAll(async () => {
  await disconnectTestDb();
});

async function makeDayWithCalories(dietPlanId, dayGroup, calories) {
  const oats = await FoodItem.findOneAndUpdate(
    { normalizedName: 'oats' },
    { $setOnInsert: { name: 'Oats', normalizedName: 'oats', nutritionPer100g: { calories: 389, protein: 17, carbs: 66, fats: 7, fiber: 10 } } },
    { upsert: true, returnDocument: 'after' }
  );
  const version = await RecipeVersion.create({
    name: 'Oats Porridge',
    parentRecipeId: new mongoose.Types.ObjectId(),
    versionNumber: 1,
    ingredients: [{ foodItemId: oats._id, rawQuantity: 100, unit: 'g' }],
    nutritionPerServing: { calories, protein: null, carbs: null, fats: null, fiber: null },
    status: 'Active',
  });
  const dayPlan = await DayPlan.create({ dietPlanId, patientId: new mongoose.Types.ObjectId(), week: 1, dayGroup });
  const mealSlot = await MealSlotPlan.create({ dayPlanId: dayPlan._id, servingTime: 'Breakfast' });
  await PlanItem.create({ mealSlotId: mealSlot._id, recipeVersionId: version._id, calculatedNutrition: { calories } });
  return dayPlan;
}

describe('validatePlanForActivation', () => {
  test('a day within +/-5% of target passes', async () => {
    const dietPlan = await DietPlan.create({
      patientId: new mongoose.Types.ObjectId(),
      dieticianId: new mongoose.Types.ObjectId(),
      dataModel: 'plan-item',
      calorieStrategy: { calorieBudget: 2000 },
    });
    await makeDayWithCalories(dietPlan._id, 'Monday', 2050); // 2.5% over - within tolerance

    const result = await validatePlanForActivation(dietPlan._id, 2000);

    expect(result.withinTolerance).toBe(true);
    expect(result.days).toHaveLength(1);
    expect(result.days[0].dayGroup).toBe('Monday');
    expect(result.days[0].withinTolerance).toBe(true);
  });

  test('a day outside +/-5% of target fails and is identified', async () => {
    const dietPlan = await DietPlan.create({
      patientId: new mongoose.Types.ObjectId(),
      dieticianId: new mongoose.Types.ObjectId(),
      dataModel: 'plan-item',
      calorieStrategy: { calorieBudget: 2000 },
    });
    await makeDayWithCalories(dietPlan._id, 'Monday', 2050); // passing
    await makeDayWithCalories(dietPlan._id, 'Tuesday', 2500); // 25% over - fails

    const result = await validatePlanForActivation(dietPlan._id, 2000);

    expect(result.withinTolerance).toBe(false);
    const monday = result.days.find((day) => day.dayGroup === 'Monday');
    const tuesday = result.days.find((day) => day.dayGroup === 'Tuesday');
    expect(monday.withinTolerance).toBe(true);
    expect(tuesday.withinTolerance).toBe(false);
    expect(tuesday.deviationPercent).toBeCloseTo(25, 0);
  });

  test('a day with no generated PlanItems is excluded rather than counted as a failure', async () => {
    const dietPlan = await DietPlan.create({
      patientId: new mongoose.Types.ObjectId(),
      dieticianId: new mongoose.Types.ObjectId(),
      dataModel: 'plan-item',
      calorieStrategy: { calorieBudget: 2000 },
    });
    await DayPlan.create({ dietPlanId: dietPlan._id, patientId: dietPlan.patientId, week: 1, dayGroup: 'Wednesday' }); // never filled

    const result = await validatePlanForActivation(dietPlan._id, 2000);

    expect(result.days).toHaveLength(0);
    expect(result.withinTolerance).toBe(true); // vacuously true - nothing to block on yet
  });
});
