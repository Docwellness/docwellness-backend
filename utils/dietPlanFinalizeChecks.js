// Deterministic checks run at finalize time (finalizeWeekPlan and
// finalizeEntireDietPlan in controllers/dietician/dietPlanController.js),
// re-verifying the dietician's actual submitted/edited selections rather
// than trusting the AI-generation-time warnings, which go stale the moment
// a recipe is added/swapped. One implementation shared by both finalize
// call sites so the rule can't drift between them.
//
// Reuses SIDE_SALAD_ELIGIBLE_SLOTS from dietPlanOptions.js - the same
// side/salad cross-listing exception applied by validateDietPlan at
// generation time, so a legitimate combo accompaniment never false-flags
// here either.

const { SIDE_SALAD_ELIGIBLE_SLOTS } = require('./dietPlanOptions');
const { SEVERE_CALORIE_DEVIATION_TOLERANCE } = require('./dietPlanValidator');

/**
 * @param normalizedMeals  cleaned {dayGroup, servingTime, recipeId, ...}[]
 * @param recipeDocsById  Map<recipeId, recipeDoc> - recipeDoc must include
 *   servingTime, name, tags (in addition to whatever nutrition fields the
 *   caller also needs for computeWeekSummary).
 * @param calorieBudget  dietPlan.calorieStrategy?.calorieBudget
 * @param computedSummary  result of computeWeekSummary(normalizedMeals, ...)
 */
function computeFinalizeBlockingIssues({ normalizedMeals, recipeDocsById, calorieBudget, computedSummary }) {
  const slotMismatches = [];
  const unknownRecipeIds = [];

  normalizedMeals.forEach((meal) => {
    const recipe = recipeDocsById.get(meal.recipeId);
    if (!recipe) {
      unknownRecipeIds.push(meal.recipeId);
      return;
    }
    const isSideOrSalad = Array.isArray(recipe.tags) && recipe.tags.some((t) => t === 'side' || t === 'salad');
    const isCrossListed = isSideOrSalad && SIDE_SALAD_ELIGIBLE_SLOTS.has(meal.servingTime);
    if (recipe.servingTime && meal.servingTime !== recipe.servingTime && !isCrossListed) {
      slotMismatches.push(
        `"${recipe.name}" is a ${recipe.servingTime} recipe but was submitted for ${meal.dayGroup} ${meal.servingTime}.`
      );
    }
  });

  let calorieSevere = null;
  if (
    typeof calorieBudget === 'number' &&
    calorieBudget > 0 &&
    computedSummary?.totalCalories > 0
  ) {
    const deviation = Math.abs(computedSummary.totalCalories - calorieBudget) / calorieBudget;
    if (deviation > SEVERE_CALORIE_DEVIATION_TOLERANCE) {
      calorieSevere = {
        actualCalories: computedSummary.totalCalories,
        budgetCalories: calorieBudget,
        deviationPercent: Math.round(deviation * 100),
        message: `Total daily calories (${computedSummary.totalCalories}) deviate ${Math.round(
          deviation * 100
        )}% from the target budget (${calorieBudget}), exceeding the ${Math.round(
          SEVERE_CALORIE_DEVIATION_TOLERANCE * 100
        )}% severe threshold.`,
      };
    }
  }

  return {
    slotMismatches,
    unknownRecipeIds: [...new Set(unknownRecipeIds)],
    calorieSevere,
    hasBlockingIssues: slotMismatches.length > 0 || unknownRecipeIds.length > 0 || calorieSevere !== null,
  };
}

module.exports = { computeFinalizeBlockingIssues };
