/**
 * Recomputes calculatedNutrition for a week's items from their current
 * servingMultiplier, and flags any {week,dayGroup} whose resulting total
 * calories fall outside dietPlan.targetProfile.tolerancePercent of the
 * plan's calorie budget. Never mutates servingMultiplier itself beyond the
 * rounding step below - proposing a corrective scale is surfaced as a
 * suggestion on the returned warning, not silently applied (see
 * services/weekTweakService.js and services/recipeSwapEngine.js for the
 * two ways a multiplier actually changes).
 */

const { scaleNutrition, sumNutrition } = require('./nutritionCalculatorService');

const DEFAULT_TOLERANCE_PERCENT = 10;
const ROUNDING_STEP = 0.25;

function roundToStep(value, step = ROUNDING_STEP) {
  return Math.round(value / step) * step;
}

function getTolerancePercent(dietPlan) {
  const configured = dietPlan?.targetProfile?.tolerancePercent;
  return typeof configured === 'number' && configured > 0 ? configured : DEFAULT_TOLERANCE_PERCENT;
}

/**
 * @param recipesById  Map<string, {nutritionPerServing}> - the Recipe docs
 *   referenced by this week's items, pre-fetched by the caller (this
 *   service does no DB access, matching nutritionCalculatorService's pure-
 *   function convention).
 * @param dailyCalorieTarget  the budget one {week,dayGroup} should hit -
 *   typically dietPlan.calorieStrategy.calorieBudget or dietPlan.totalCalories.
 */
function balanceWeek({ dietPlan, week, recipesById, dailyCalorieTarget }) {
  const tolerancePercent = getTolerancePercent(dietPlan);
  const warnings = [];

  for (const day of dietPlan.days || []) {
    if (day.week !== week) continue;

    const dayItemNutrition = [];
    for (const meal of day.meals || []) {
      for (const item of meal.items || []) {
        const recipe = recipesById.get(item.recipeId?.toString ? item.recipeId.toString() : item.recipeId);
        const base = recipe?.nutritionPerServing;
        item.calculatedNutrition = base
          ? scaleNutrition(base, item.servingMultiplier ?? 1)
          : { calories: null, protein: null, carbs: null, fats: null, fiber: null };
        dayItemNutrition.push(item.calculatedNutrition);
      }
    }

    const dayTotal = sumNutrition(dayItemNutrition);

    if (dailyCalorieTarget > 0) {
      const deviation = (dayTotal.calories - dailyCalorieTarget) / dailyCalorieTarget;
      if (Math.abs(deviation) * 100 > tolerancePercent) {
        // Suggestion only: what uniform multiplier on this day's currently-
        // unlocked items would close the gap, for the caller/UI to offer -
        // never applied here.
        const unlockedCalories = day.meals
          .flatMap((m) => m.items)
          .filter((item) => !item.locked)
          .reduce((sum, item) => sum + (item.calculatedNutrition?.calories || 0), 0);
        const lockedCalories = dayTotal.calories - unlockedCalories;
        const suggestedScaleForUnlocked =
          unlockedCalories > 0 ? Math.max(0, (dailyCalorieTarget - lockedCalories) / unlockedCalories) : null;

        warnings.push({
          week,
          dayGroup: day.dayGroup,
          actualCalories: dayTotal.calories,
          targetCalories: dailyCalorieTarget,
          deviationPercent: deviation * 100,
          suggestedScaleForUnlocked:
            suggestedScaleForUnlocked !== null ? roundToStep(suggestedScaleForUnlocked) : null,
        });
      }
    }
  }

  if ((dietPlan.days || []).some((d) => d.week === week)) dietPlan.markModified('days');

  return { warnings, tolerancePercent };
}

module.exports = { balanceWeek, roundToStep, getTolerancePercent, DEFAULT_TOLERANCE_PERCENT };
