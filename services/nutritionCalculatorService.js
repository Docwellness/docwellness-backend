/**
 * Pure nutrition math, no DB access - shared by services/recipeSelectionEngine.js
 * (Phase 2) and, later, dietPlanAutoBalanceService.js/weekTweakService.js/
 * recipeSwapEngine.js so none of them reimplement the same arithmetic.
 */

const NUTRITION_KEYS = ['calories', 'protein', 'carbs', 'fats', 'fiber'];

/**
 * totalCalories * mealDistribution[servingTime], falling back to an even
 * split across REQUIRED_SERVING_TIMES when mealDistribution is absent
 * (e.g. a plan created before Phase 1's targetProfile existed).
 * mealDistribution may be a plain object OR a real Mongoose Map instance
 * (DietPlan.targetProfile.mealDistribution, read off a non-.lean() document)
 * - `.get()` is required for the latter, plain bracket access silently
 * returns undefined on a Map instance.
 */
function slotCalorieTarget({ mealDistribution, servingTime, totalCalories, allServingTimes }) {
  if (!totalCalories) return null;
  const fraction =
    typeof mealDistribution?.get === 'function' ? mealDistribution.get(servingTime) : mealDistribution?.[servingTime];
  if (typeof fraction === 'number' && fraction > 0) return totalCalories * fraction;
  return totalCalories / (allServingTimes?.length || 7);
}

/** Multiplies every present nutrition field by `multiplier`; nulls stay null. */
function scaleNutrition(nutrition, multiplier) {
  const result = {};
  for (const key of NUTRITION_KEYS) {
    const value = nutrition?.[key];
    result[key] = typeof value === 'number' ? value * multiplier : null;
  }
  return result;
}

/** Sums an array of nutrition objects, treating missing/null fields as 0. */
function sumNutrition(nutritionList) {
  const result = { calories: 0, protein: 0, carbs: 0, fats: 0, fiber: 0 };
  for (const nutrition of nutritionList || []) {
    for (const key of NUTRITION_KEYS) {
      result[key] += typeof nutrition?.[key] === 'number' ? nutrition[key] : 0;
    }
  }
  return result;
}

/**
 * 0-1 score for how close a recipe's calories (at 1x serving) are to a
 * slot's calorie target - 1.0 at an exact match, 0 once the deviation
 * reaches/exceeds the target itself (i.e. the recipe is ≥2x or ≤0x the
 * target), clamped so it never goes negative.
 */
function calorieFitScore({ recipeCalories, target }) {
  if (!(target > 0) || typeof recipeCalories !== 'number') return 0;
  const deviation = Math.abs(recipeCalories - target) / target;
  return Math.max(0, 1 - deviation);
}

/**
 * 0-1 cosine-similarity-style score between a recipe's macro-calorie split
 * (protein/carbs/fats, each converted to calories via the standard 4/4/9
 * kcal-per-gram factors) and the plan's target macro percentages
 * (macroStrategy.{proteinPercent,carbsPercent,fatPercent}). Returns null
 * (treated as neutral, not penalized) when either side has no usable data,
 * rather than guessing.
 */
function macroFitScore({ recipeMacros, macroStrategy }) {
  const proteinPercent = macroStrategy?.proteinPercent;
  const carbsPercent = macroStrategy?.carbsPercent;
  const fatPercent = macroStrategy?.fatPercent;
  if (![proteinPercent, carbsPercent, fatPercent].every((v) => typeof v === 'number')) return null;

  const protein = recipeMacros?.protein;
  const carbs = recipeMacros?.carbs;
  const fats = recipeMacros?.fats;
  if (![protein, carbs, fats].every((v) => typeof v === 'number')) return null;

  const recipeVector = [protein * 4, carbs * 4, fats * 9];
  const targetVector = [proteinPercent, carbsPercent, fatPercent];

  const recipeTotal = recipeVector.reduce((a, b) => a + b, 0);
  if (recipeTotal <= 0) return null;

  const dot = recipeVector.reduce((sum, v, i) => sum + v * targetVector[i], 0);
  const recipeNorm = Math.sqrt(recipeVector.reduce((sum, v) => sum + v * v, 0));
  const targetNorm = Math.sqrt(targetVector.reduce((sum, v) => sum + v * v, 0));
  if (recipeNorm === 0 || targetNorm === 0) return null;

  return dot / (recipeNorm * targetNorm);
}

module.exports = { slotCalorieTarget, scaleNutrition, sumNutrition, calorieFitScore, macroFitScore };
