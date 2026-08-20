/**
 * utils/dietPlanReadDispatch.js - the v4.0 model-aware dispatcher. Two
 * things this proves: a 'days-array' plan's dispatched output is
 * byte-identical to calling dietPlanLegacyView.js's getFinalizedWeeks
 * directly (the regression guard on "don't touch the live path"), and a
 * 'plan-item' plan's output is correctly synthesized from
 * DayPlan/MealSlotPlan/PlanItem/RecipeVersion, including the
 * recipeVersionOverrides extra reflecting an edited (V2+) item.
 */

const { connectTestDb, disconnectTestDb, clearTestDb } = require('./helpers/testDb');
const { getFinalizedWeeks } = require('../utils/dietPlanLegacyView');

let mongoose;
let DietPlan;
let DayPlan;
let MealSlotPlan;
let PlanItem;
let SupplementItem;
let RecipeVersion;
let FoodItem;
let Recipe;
let getPatientVisibleWeeks;
let buildPlanItemPatientView;

beforeAll(async () => {
  await connectTestDb();
  mongoose = require('mongoose');
  ({ DietPlan, DayPlan, MealSlotPlan, PlanItem, SupplementItem, RecipeVersion, FoodItem, Recipe } = require('../models'));
  ({ getPatientVisibleWeeks, buildPlanItemPatientView } = require('../utils/dietPlanReadDispatch'));
});

afterEach(async () => {
  await clearTestDb();
});

afterAll(async () => {
  await disconnectTestDb();
});

describe('getPatientVisibleWeeks - days-array plans', () => {
  test('a days-array plan (default dataModel) is byte-identical to getFinalizedWeeks', async () => {
    const dietPlan = {
      dataModel: 'days-array',
      finalizedPlan: { weeks: [{ week: 1, dailyMeals: [{ dayGroup: 'Monday', servingTime: 'Lunch', recipeId: 'abc', servings: 2 }] }] },
    };
    expect(await getPatientVisibleWeeks(dietPlan)).toEqual(getFinalizedWeeks(dietPlan));
  });

  test('a plan with no dataModel set at all (pre-v4.0 data) also falls through to the legacy path', async () => {
    const dietPlan = { finalizedPlan: { weeks: [{ week: 1, dailyMeals: [] }] } };
    expect(await getPatientVisibleWeeks(dietPlan)).toEqual(getFinalizedWeeks(dietPlan));
  });
});

describe('getPatientVisibleWeeks / buildPlanItemPatientView - plan-item plans', () => {
  async function seedPlanItemPlan() {
    const dieticianId = new mongoose.Types.ObjectId();
    const patientId = new mongoose.Types.ObjectId();
    const dietPlan = await DietPlan.create({ patientId, dieticianId, dataModel: 'plan-item' });

    const oats = await FoodItem.create({ name: 'Oats', normalizedName: 'oats', nutritionPer100g: { calories: 389, protein: 17, carbs: 66, fats: 7, fiber: 10 } });
    const recipe = await Recipe.create({
      dieticianId,
      name: 'Oats Porridge',
      servingTime: 'Breakfast',
      components: [{ label: 'Oats Porridge', quantity: 100, unit: 'g' }],
      ingredients: [{ name: 'Oats', quantity: 100, unit: 'g' }],
      nutrition: { calories: 300, protein: 10, carbs: 30, fats: 5, fiber: 3 },
    });
    await new Promise((resolve) => setTimeout(resolve, 60)); // let the post-save V1 sync hook land
    const v1 = await RecipeVersion.findOne({ parentRecipeId: recipe._id, versionNumber: 1 });

    const dayPlan = await DayPlan.create({ dietPlanId: dietPlan._id, patientId, week: 1, dayGroup: 'Monday' });
    const mealSlot = await MealSlotPlan.create({ dayPlanId: dayPlan._id, servingTime: 'Breakfast' });
    const planItem = await PlanItem.create({ mealSlotId: mealSlot._id, recipeVersionId: v1._id, calculatedNutrition: v1.nutritionPerServing });

    const supplement = await Recipe.create({ dieticianId, name: 'Multivitamin', servingTime: 'Breakfast', category: 'Supplements' });
    await SupplementItem.create({ mealSlotId: mealSlot._id, supplementRecipeId: supplement._id, dosage: '1 tablet', timingAnchor: 'post' });

    return { dietPlan, recipe, v1, oats, planItem, supplement };
  }

  test('getPatientVisibleWeeks synthesizes dailyMeals from PlanItem, using the underlying Recipe id', async () => {
    const { dietPlan, recipe } = await seedPlanItemPlan();

    const weeks = await getPatientVisibleWeeks(dietPlan);

    expect(weeks).toHaveLength(1);
    expect(weeks[0].week).toBe(1);
    expect(weeks[0].dailyMeals).toEqual([
      { dayGroup: 'Monday', servingTime: 'Breakfast', recipeId: String(recipe._id), servings: 1 },
    ]);
  });

  test('buildPlanItemPatientView returns V1 ingredients/steps when never edited', async () => {
    const { dietPlan, recipe } = await seedPlanItemPlan();

    const { recipeVersionOverrides } = await buildPlanItemPatientView(dietPlan);

    const override = recipeVersionOverrides[String(recipe._id)];
    expect(override.versionNumber).toBe(1);
    expect(override.ingredients).toEqual([{ name: 'Oats', quantity: 100, unit: 'g', image: null, isScalable: true }]);
    // 100g oats @ 389kcal/100g = 389 - proves getRecipesForServing's
    // servings/servingSize.quantity ratio has real, non-rescaled data to
    // work from once the caller pins servingSize.quantity to 1 too.
    expect(override.nutritionPerServing.calories).toBeCloseTo(389);
  });

  test('buildPlanItemPatientView reflects a custom (V2) version when the item was edited', async () => {
    const { dietPlan, recipe, v1, oats, planItem } = await seedPlanItemPlan();
    const { createCustomVersion } = require('../services/recipeVersioningService');
    const v2 = await createCustomVersion(v1._id, [{ foodItemId: oats._id, rawQuantity: 250, unit: 'g' }]);
    planItem.recipeVersionId = v2._id;
    await planItem.save();

    const { recipeVersionOverrides } = await buildPlanItemPatientView(dietPlan);

    const override = recipeVersionOverrides[String(recipe._id)];
    expect(override.versionNumber).toBe(2);
    expect(override.ingredients[0].quantity).toBe(250);
  });

  test('buildPlanItemPatientView maps SupplementItem into the legacy supplementScheduleByWeek shape', async () => {
    const { dietPlan, supplement } = await seedPlanItemPlan();

    const { supplementScheduleByWeek } = await buildPlanItemPatientView(dietPlan);

    expect(supplementScheduleByWeek[1]).toEqual([
      {
        dayGroup: 'Monday',
        servingTime: 'Breakfast',
        supplementId: String(supplement._id),
        dosage: '1 tablet',
        instructions: null,
        timingAnchor: 'post',
      },
    ]);
  });
});
