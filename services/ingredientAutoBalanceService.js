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
 * Risk mitigation (design.md's "Auto-balance could produce implausible
 * ingredient quantities" risk): uniform proportional scaling of independent
 * ingredient quantities can in principle demand an arbitrarily large or
 * small scale to hit a target exactly (e.g. "10x every ingredient"). Rather
 * than ever apply that, the ratio is clamped to
 * [MIN_SCALE_RATIO, MAX_SCALE_RATIO] - a target outside what that clamped
 * ratio can reach is deliberately under/over-shot instead of producing an
 * unrealistic portion. Per design.md, this means the day is "left flagged as
 * outside tolerance rather than produce an unrealistic quantity" - that
 * flagging is services/planActivationService.js's job at finalize time, not
 * this function's; a caller here just gets a version that didn't fully hit
 * its requested target.
 */

const RecipeVersion = require('../models/RecipeVersion');
const PlanItem = require('../models/PlanItem');
const MealSlotPlan = require('../models/MealSlotPlan');
const DayPlan = require('../models/DayPlan');
const { createCustomVersion } = require('./recipeVersioningService');

// A target requiring more than a 3x scale-up or scale-down of an ingredient's
// current amount is treated as unreachable via uniform scaling - e.g. "1.3
// eggs" is already a stretch at 1.3x, and something like 5x would produce a
// clearly unrealistic real-world portion. Chosen as a simple, food-agnostic
// bound (no per-ingredient/per-unit data needed) per design.md's "sane
// per-ingredient bound" mitigation.
const MIN_SCALE_RATIO = 1 / 3;
const MAX_SCALE_RATIO = 3;

/**
 * Scales every ingredient in recipeVersionId's ingredients[] by the same
 * ratio (targetCalories / current nutritionPerServing.calories), clamped to
 * [MIN_SCALE_RATIO, MAX_SCALE_RATIO], creating and returning a new
 * RecipeVersion - never mutates recipeVersionId's document (same
 * immutability guarantee as createCustomVersion itself, which this
 * delegates to). Repointing a PlanItem to the new version is the caller's
 * job (see autoBalanceDay/autoBalanceWeek below, or the API layer for a
 * single-item auto-balance call).
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

  const requestedRatio = targetCalories / currentCalories;
  const ratio = Math.min(MAX_SCALE_RATIO, Math.max(MIN_SCALE_RATIO, requestedRatio));
  const updatedIngredients = currentVersion.ingredients.map((ingredient) => ({
    foodItemId: ingredient.foodItemId,
    rawQuantity: Math.round(ingredient.rawQuantity * ratio * 100) / 100,
    unit: ingredient.unit,
    preparation: ingredient.preparation,
  }));

  const newVersion = await createCustomVersion(recipeVersionId, updatedIngredients);
  // In-memory annotation only (not a schema path, never persisted) - lets an
  // immediate caller (autoBalanceDay below) see that the target couldn't be
  // fully reached without inspecting ratios itself.
  newVersion._wasScaleClamped = ratio !== requestedRatio;
  return newVersion;
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
    results.push({
      planItemId: item._id,
      newVersionId: newVersion._id,
      targetCalories: itemTargetCalories,
      achievedCalories: newVersion.nutritionPerServing.calories,
      wasClamped: !!newVersion._wasScaleClamped,
    });
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
