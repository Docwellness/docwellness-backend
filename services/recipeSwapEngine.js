/**
 * "Swap vs Scale": given an over/under-budget item, either swap it for a
 * lighter/heavier alternative from the recipe pool or scale its portion.
 * All DB access (fetching the candidate recipe pool, the target Recipe doc)
 * is the caller's job - this module is pure logic over already-fetched data,
 * same convention as the other Phase 2 services.
 */

const { scaleNutrition } = require('./nutritionCalculatorService');

/**
 * @param recipePool  array of {id, name, servingTime, calories,
 *   mealSlotSuitability, nutritionPerServing} - candidates to consider.
 * @param direction  'lighter' | 'heavier' - lighter candidates must be
 *   materially lighter (<=80% of currentCalories), heavier materially
 *   heavier (>=120%), matching the original UX spec's 0.8x threshold.
 * @param excludeRecipeId  the item's current recipe, never offered as its
 *   own alternative.
 */
function findSwapAlternatives({ recipePool, servingTime, currentCalories, direction, excludeRecipeId, limit = 3 }) {
  // A recipe is eligible for this slot only if it's a true slot-owner, or it
  // carries EXPLICIT positive suitability data for this slot (e.g. a
  // broadened-in side/salad, see recipeSelectionEngine.js's header) - unlike
  // scoreCandidate's ranking-only default of 1, a recipe with no signal at
  // all must NOT be treated as eligible here, or a completely unrelated
  // recipe (wrong slot, no mealSlotSuitability) would pass through.
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

function findItem({ dietPlan, week, dayGroup, servingTime, itemId }) {
  const day = (dietPlan.days || []).find((d) => d.week === week && d.dayGroup === dayGroup);
  const meal = day?.meals?.find((m) => m.servingTime === servingTime);
  const item = meal?.items?.id ? meal.items.id(itemId) : meal?.items?.find((i) => i._id?.toString() === itemId);
  if (!day || !meal || !item) {
    throw new Error(`No item found for week ${week} / ${dayGroup} / ${servingTime} / ${itemId}`);
  }
  return item;
}

/** Swaps an item's recipe, recomputes its nutrition, and records the change. */
function applySwap({ dietPlan, week, dayGroup, servingTime, itemId, newRecipe, reason = null }) {
  const item = findItem({ dietPlan, week, dayGroup, servingTime, itemId });

  item.swapHistory = item.swapHistory || [];
  item.swapHistory.push({ fromRecipeId: item.recipeId, toRecipeId: newRecipe._id || newRecipe.id, at: new Date(), reason });

  item.recipeId = newRecipe._id || newRecipe.id;
  item.calculatedNutrition = newRecipe.nutritionPerServing
    ? scaleNutrition(newRecipe.nutritionPerServing, item.servingMultiplier ?? 1)
    : item.calculatedNutrition;
  item.displayText = newRecipe.name || item.displayText;

  dietPlan.markModified('days');
  return item;
}

/** Rescales an item's portion in place, recomputing its cached nutrition. */
function applyScale({ dietPlan, week, dayGroup, servingTime, itemId, newMultiplier, recipe }) {
  if (!(newMultiplier > 0)) throw new Error('newMultiplier must be a positive number');
  const item = findItem({ dietPlan, week, dayGroup, servingTime, itemId });

  item.servingMultiplier = newMultiplier;
  if (recipe?.nutritionPerServing) {
    item.calculatedNutrition = scaleNutrition(recipe.nutritionPerServing, newMultiplier);
  }

  dietPlan.markModified('days');
  return item;
}

module.exports = { findSwapAlternatives, applySwap, applyScale, findItem };
