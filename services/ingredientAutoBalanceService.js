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
const { isCountableServing, snapCountablePortion } = require('../utils/servingUnits');

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
  let ratio = Math.min(MAX_SCALE_RATIO, Math.max(MIN_SCALE_RATIO, requestedRatio));

  // Serving-size realism (diet-plan-wizard/portion-realism): a countable
  // serving (roti/idli/egg/slice) must not be scaled below 1, and lands on
  // a 0.5 step. We re-derive the scale ratio from the SNAPPED serving
  // quantity so the new version's ingredients, calories, and "Makes"
  // component all stay in sync (createCustomVersion rescales the component
  // off the resulting calorie ratio - moving the ingredients by
  // effectiveRatio is what lands that component on snappedQty). A dish with
  // no component, or more than one, is continuous and untouched here.
  let flooredTo = null;
  const servingComponent =
    Array.isArray(currentVersion.components) && currentVersion.components.length === 1
      ? currentVersion.components[0]
      : null;
  if (isCountableServing(servingComponent) && servingComponent.quantity > 0) {
    const projectedQuantity = servingComponent.quantity * ratio;
    const snappedQuantity = snapCountablePortion(projectedQuantity);
    if (Math.abs(snappedQuantity - projectedQuantity) > 1e-9) {
      ratio = Math.min(MAX_SCALE_RATIO, Math.max(MIN_SCALE_RATIO, snappedQuantity / servingComponent.quantity));
      flooredTo = snappedQuantity;
    }
  }

  const updatedIngredients = currentVersion.ingredients.map((ingredient) => ({
    foodItemId: ingredient.foodItemId,
    rawQuantity: Math.round(ingredient.rawQuantity * ratio * 100) / 100,
    unit: ingredient.unit,
    preparation: ingredient.preparation,
  }));

  const newVersion = await createCustomVersion(recipeVersionId, updatedIngredients);
  // In-memory annotations only (not schema paths, never persisted) - let an
  // immediate caller (autoBalanceDay below) see that the target couldn't be
  // fully reached without inspecting ratios itself.
  newVersion._wasScaleClamped = ratio !== requestedRatio;
  newVersion._flooredTo = flooredTo;
  return newVersion;
}

/**
 * Auto-balances the adjustable PlanItems in one DayPlan to collectively hit
 * targetDailyCalories, roughly preserving relative meal-to-meal proportions
 * rather than pushing every item to the same absolute number.
 *
 * Skipped entirely (never rescaled; their calories are a fixed baseline the
 * rest of the day balances around):
 *   - `locked` items (dietician pinned the portion AND blocked swap/remove)
 *   - `pinned` items (dietician hand-edited the portion; still swappable) -
 *     diet-plan-wizard/refine-portions-pinning
 *   - items with no current calorie figure (unresolved ingredients)
 *
 * Two-pass partition (diet-plan-wizard/portion-realism): countable-serving
 * items (roti/idli/egg) are solved first - flooring/snapping in
 * autoBalanceIngredients can move them off their proportional share - then
 * the continuous items (dal in grams, a drink in ml) absorb whatever budget
 * is left. If there are no continuous items to absorb the difference, the
 * countable results stand and the day may be left outside tolerance for the
 * dietician to resolve (surfaced by the finalize activation check), rather
 * than an implausible fractional serving being forced.
 */
async function autoBalanceDay(dayPlanId, targetDailyCalories) {
  const mealSlots = await MealSlotPlan.find({ dayPlanId });
  const mealSlotIds = mealSlots.map((slot) => slot._id);
  const planItems = await PlanItem.find({ mealSlotId: { $in: mealSlotIds } });

  const fixedCalories = planItems
    .filter((item) => item.locked || item.pinned)
    .reduce((sum, item) => sum + (item.calculatedNutrition?.calories || 0), 0);
  const adjustableItems = planItems.filter(
    (item) => !item.locked && !item.pinned && (item.calculatedNutrition?.calories || 0) > 0
  );
  if (adjustableItems.length === 0) {
    return [];
  }

  // Classify each adjustable item by its serving component - needs the
  // RecipeVersion, so batch-fetch rather than one findById per item.
  const versionsById = new Map(
    (await RecipeVersion.find({ _id: { $in: adjustableItems.map((item) => item.recipeVersionId) } })).map((version) => [
      String(version._id),
      version,
    ])
  );
  const isItemCountable = (item) => {
    const version = versionsById.get(String(item.recipeVersionId));
    const component =
      version && Array.isArray(version.components) && version.components.length === 1 ? version.components[0] : null;
    return isCountableServing(component);
  };
  const countableItems = adjustableItems.filter(isItemCountable);
  const continuousItems = adjustableItems.filter((item) => !isItemCountable(item));

  const adjustableCalories = adjustableItems.reduce((sum, item) => sum + item.calculatedNutrition.calories, 0);
  const results = [];

  const applyToItem = async (item, itemTargetCalories) => {
    if (!(itemTargetCalories > 0)) return null;
    const newVersion = await autoBalanceIngredients(item.recipeVersionId, itemTargetCalories);
    item.recipeVersionId = newVersion._id;
    item.calculatedNutrition = newVersion.nutritionPerServing;
    await item.save();
    const result = {
      planItemId: item._id,
      newVersionId: newVersion._id,
      targetCalories: itemTargetCalories,
      achievedCalories: newVersion.nutritionPerServing.calories,
      wasClamped: !!newVersion._wasScaleClamped,
      flooredTo: newVersion._flooredTo ?? null,
    };
    results.push(result);
    return result;
  };

  // Pass 1: countable items take their proportional share of the budget,
  // but flooring/snapping may push them off it - record what they actually
  // achieved so pass 2 knows how much budget is really left.
  let countableAchieved = 0;
  for (const item of countableItems) {
    const share = item.calculatedNutrition.calories / adjustableCalories;
    const itemTarget = (targetDailyCalories - fixedCalories) * share;
    const before = item.calculatedNutrition.calories;
    const result = await applyToItem(item, itemTarget);
    countableAchieved += result ? result.achievedCalories : before;
  }

  // Pass 2: continuous items absorb the remaining budget, proportional to
  // their current calories.
  const remainingForContinuous = targetDailyCalories - fixedCalories - countableAchieved;
  const continuousCalories = continuousItems.reduce((sum, item) => sum + item.calculatedNutrition.calories, 0);
  if (continuousItems.length > 0 && remainingForContinuous > 0 && continuousCalories > 0) {
    for (const item of continuousItems) {
      const share = item.calculatedNutrition.calories / continuousCalories;
      await applyToItem(item, remainingForContinuous * share);
    }
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

/**
 * Auto-balances every generated week of a DietPlan, not just one. The
 * wizard's Refine Portions step is single-week UI, but a Silver-tier plan
 * has all 4 weeks generated up front (see
 * generation_step_controller.dart's _initialWeeksForTier) and
 * services/planActivationService.js's finalize gate validates EVERY week -
 * so the entry balance has to cover them all or weeks 2-4 stay at raw V1
 * portions and block activation ("N day(s) outside +/-5% tolerance").
 */
async function autoBalancePlan(dietPlanId, targetDailyCalories) {
  const dayPlans = await DayPlan.find({ dietPlanId }).select('week');
  const weeks = [...new Set(dayPlans.map((dayPlan) => dayPlan.week))].sort((a, b) => a - b);
  const results = [];
  for (const week of weeks) {
    const weekResults = await autoBalanceWeek(dietPlanId, week, targetDailyCalories);
    results.push({ week, days: weekResults });
  }
  return results;
}

module.exports = { autoBalanceIngredients, autoBalanceDay, autoBalanceWeek, autoBalancePlan };
