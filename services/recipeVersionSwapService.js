/**
 * v4.0's Step 2 "swap icon" support - repoints a PlanItem at a different
 * recipe's V1 RecipeVersion. This is now the ONLY swap-alternatives
 * implementation in the codebase - services/recipeSwapEngine.js (the
 * days-array/servingMultiplier-based sibling) was deleted as part of the
 * v4.0 hard-cutover decision (see the "Diet Plan v4.0" plan doc's Phase 5
 * progress log), so findSwapAlternatives now lives here directly rather
 * than being imported from that now-gone file.
 *
 * swapToRecipe is genuinely new logic, not a port of the old applySwap:
 * unlike the old model's applySwap (which rescaled the newly-swapped
 * recipe's nutrition by the item's existing servingMultiplier), swapping a
 * PlanItem needs no rescale at all - the target recipe's V1 is used exactly
 * as authored, matching services/menuGenerationService.js's "no scaling at
 * generation time" philosophy. There's also no swapHistory field on
 * PlanItem (v4.0 doesn't model swap history yet - add it if the product
 * asks for it later).
 */

const PlanItem = require('../models/PlanItem');
const RecipeVersion = require('../models/RecipeVersion');

/**
 * Pure logic over an already-fetched candidate pool - no DB access. Same
 * algorithm the deleted recipeSwapEngine.js used: a candidate is eligible
 * for a slot only if it's a true slot-owner or carries explicit positive
 * mealSlotSuitability data for it (a recipe with no signal at all must NOT
 * be treated as eligible, unlike scoring-only code elsewhere that defaults
 * unknown suitability to neutral).
 *
 * @param recipePool  array of {id, name, servingTime, calories, mealSlotSuitability}.
 * @param direction  'lighter' | 'heavier' - lighter candidates must be
 *   materially lighter (<=80% of currentCalories), heavier materially
 *   heavier (>=120%).
 * @param excludeRecipeId  the item's current recipe, never offered as its
 *   own alternative.
 */
function findSwapAlternatives({ recipePool, servingTime, currentCalories, direction, excludeRecipeId, limit = 3 }) {
  const isEligibleForSlot = (r) =>
    r.servingTime === servingTime || typeof r.mealSlotSuitability?.[servingTime] === 'number';
  const suitabilityOf = (r) =>
    (r.servingTime === servingTime ? 1 : 0) +
    (typeof r.mealSlotSuitability?.[servingTime] === 'number' ? r.mealSlotSuitability[servingTime] : 0);

  const eligible = (recipePool || []).filter((r) => {
    if (r.id === excludeRecipeId) return false;
    if (!isEligibleForSlot(r)) return false;
    if (suitabilityOf(r) <= 0) return false;
    if (typeof r.calories !== 'number') return false;
    if (direction === 'lighter') return r.calories <= currentCalories * 0.8;
    if (direction === 'heavier') return r.calories >= currentCalories * 1.2;
    return true;
  });

  return eligible
    .map((recipe) => ({ recipe, calorieProximity: Math.abs(recipe.calories - currentCalories) }))
    .sort((a, b) => a.calorieProximity - b.calorieProximity)
    .slice(0, limit)
    .map((c) => c.recipe);
}

/**
 * Repoints planItemId at newParentRecipeId's Active, fully-resolved V1
 * RecipeVersion. Throws (does not silently no-op) if that recipe has no
 * eligible V1 - matches services/menuGenerationService.js's data-coverage
 * gate: a recipe with unresolved ingredients can't be selected here either.
 */
async function swapToRecipe(planItemId, newParentRecipeId) {
  const planItem = await PlanItem.findById(planItemId);
  if (!planItem) {
    throw new Error(`PlanItem not found: ${planItemId}`);
  }

  const newV1 = await RecipeVersion.findOne({ parentRecipeId: newParentRecipeId, versionNumber: 1, status: 'Active' });
  if (!newV1) {
    throw new Error(`No Active V1 RecipeVersion found for Recipe ${newParentRecipeId}`);
  }
  if (newV1.hasUnresolvedIngredients) {
    throw new Error(`RecipeVersion ${newV1._id} has unresolved ingredients and cannot be selected`);
  }

  planItem.recipeVersionId = newV1._id;
  planItem.calculatedNutrition = newV1.nutritionPerServing;
  await planItem.save();
  return planItem;
}

module.exports = { findSwapAlternatives, swapToRecipe };
