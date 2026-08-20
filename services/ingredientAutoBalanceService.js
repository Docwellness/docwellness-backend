/**
 * v4.0's Step 3 auto-balance: the successor to
 * services/dietPlanAutoBalanceService.js (which recomputes nutrition from an
 * existing servingMultiplier and only ever SUGGESTS a scale, never applies
 * it). This service scales every ingredient's rawQuantity uniformly to hit
 * a calorie target and DOES apply it, by delegating to
 * services/recipeVersioningService.js::createCustomVersion - auto-balance IS
 * a custom-version-creation with computed-rather-than-typed quantities, so
 * it shares one code path with manual ingredient editing rather than a
 * second divergent one.
 *
 * Known risk, flagged in the plan doc rather than solved here: uniform
 * proportional scaling of independent ingredient quantities can produce
 * unrealistic real-world portions (e.g. "1.3 eggs") more visibly than the
 * old single-scalar servingMultiplier did. No rounding/sanity heuristic is
 * applied here beyond a plain 2-decimal round - the Step 3 Ingredient
 * Editor UI (Phase 5) is where a dietician would see and correct this.
 */

const RecipeVersion = require('../models/RecipeVersion');
const PlanItem = require('../models/PlanItem');
const MealSlotPlan = require('../models/MealSlotPlan');
const DayPlan = require('../models/DayPlan');
const { createCustomVersion } = require('./recipeVersioningService');

/**
 * Scales every ingredient in recipeVersionId's ingredients[] by the same
 * ratio (targetCalories / current nutritionPerServing.calories), creating
 * and returning a new RecipeVersion - never mutates recipeVersionId's
 * document (same immutability guarantee as createCustomVersion itself,
 * which this delegates to). Repointing a PlanItem to the new version is the
 * caller's job (see autoBalanceDay/autoBalanceWeek below, or the API layer
 * for a single-item auto-balance call).
 */
async function autoBalanceIngredients(recipeVersionId, targetCalories) {
  const currentVersion = await RecipeVersion.findById(recipeVersionId);
  if (!currentVersion) {
    throw new Error(`RecipeVersion not found: ${recipeVersionId}`);
  }
  const currentCalories = currentVersion.nutritionPerServing?.calories;
  if (!(currentCalories > 0)) {
    throw new Error(`RecipeVersion ${recipeVersionId} has no positive current calories to scale from`);
  }
  if (!(targetCalories > 0)) {
    throw new Error('targetCalories must be a positive number');
  }

  const ratio = targetCalories / currentCalories;
  const updatedIngredients = currentVersion.ingredients.map((ingredient) => ({
    foodItemId: ingredient.foodItemId,
    rawQuantity: Math.round(ingredient.rawQuantity * ratio * 100) / 100,
    unit: ingredient.unit,
    preparation: ingredient.preparation,
  }));

  return createCustomVersion(recipeVersionId, updatedIngredients);
}

/**
 * Auto-balances every UNLOCKED PlanItem in one DayPlan to collectively hit
 * targetDailyCalories - each unlocked item's individual target is its
 * proportional share of (targetDailyCalories - locked items' calories),
 * weighted by that item's current calorie share among unlocked items, so
 * relative meal-to-meal proportions are roughly preserved rather than every
 * item being pushed to the same absolute number. Locked items and items
 * with no current calorie figure (unresolved ingredients) are skipped
 * entirely - same "locked items are never touched" convention as the old
 * dietPlanAutoBalanceService.js/weekTweakService.js.
 */
async function autoBalanceDay(dayPlanId, targetDailyCalories) {
  const mealSlots = await MealSlotPlan.find({ dayPlanId });
  const mealSlotIds = mealSlots.map((slot) => slot._id);
  const planItems = await PlanItem.find({ mealSlotId: { $in: mealSlotIds } });

  const lockedCalories = planItems
    .filter((item) => item.locked)
    .reduce((sum, item) => sum + (item.calculatedNutrition?.calories || 0), 0);
  const unlockedItems = planItems.filter((item) => !item.locked && (item.calculatedNutrition?.calories || 0) > 0);
  const unlockedCalories = unlockedItems.reduce((sum, item) => sum + item.calculatedNutrition.calories, 0);

  if (unlockedItems.length === 0 || unlockedCalories <= 0) {
    return [];
  }

  const remainingTarget = targetDailyCalories - lockedCalories;
  const results = [];
  for (const item of unlockedItems) {
    const itemShare = item.calculatedNutrition.calories / unlockedCalories;
    const itemTargetCalories = remainingTarget * itemShare;
    if (!(itemTargetCalories > 0)) continue; // locked items already exceed the day's target - nothing sane to solve for

    const newVersion = await autoBalanceIngredients(item.recipeVersionId, itemTargetCalories);
    item.recipeVersionId = newVersion._id;
    item.calculatedNutrition = newVersion.nutritionPerServing;
    await item.save();
    results.push({ planItemId: item._id, newVersionId: newVersion._id, targetCalories: itemTargetCalories });
  }
  return results;
}

/** Auto-balances every DayPlan (dayGroup) in one week of a DietPlan. */
async function autoBalanceWeek(dietPlanId, week, targetDailyCalories) {
  const dayPlans = await DayPlan.find({ dietPlanId, week });
  const results = [];
  for (const dayPlan of dayPlans) {
    const dayResults = await autoBalanceDay(dayPlan._id, targetDailyCalories);
    results.push({ dayGroup: dayPlan.dayGroup, items: dayResults });
  }
  return results;
}

module.exports = { autoBalanceIngredients, autoBalanceDay, autoBalanceWeek };
