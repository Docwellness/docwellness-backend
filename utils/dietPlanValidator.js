// Deterministic post-generation checks for AI diet plans: verifies the model
// only referenced recipes it was actually given (closed-world check against
// recipePool), that servingTime slots match, and flags (non-blocking)
// calorie deviation from the requested strategy. Mirrors the role
// utils/dietaryConstraintValidator.js plays for individual recipes - the AI
// proposes, this catches drift deterministically, the dietician reviews.

const { SIDE_SALAD_ELIGIBLE_SLOTS } = require('./dietPlanOptions');
const { DAY_GROUPS } = require('./dayGroups');

const CALORIE_DEVIATION_TOLERANCE = 0.1; // ±10%, per the architecture's tolerance-based reconciliation

// Mirrors the dietician app's trend-aware default-quantity logic
// (patients_controller.dart's _defaultServingsForTrend/_isTrendScoped) -
// used ONLY to estimate a realistic calorie total for this deviation
// check, never to alter the generated plan/recipe selection itself. The AI
// always proposes full-size combo portions (unaware of the patient's
// weight-loss/gain goal); the dietician app scales them down/up
// interactively once the dietician opens the plan. Without this, the
// deviation warning compares the budget against a number that was never
// the realistically-intended amount, firing loudly on totally normal
// weight-loss combos.
const TREND_SCOPED_SLOTS = new Set(['Lunch', 'Dinner', 'Evening Snack']);

function isPieceBased(recipe) {
  return recipe?.servingSize?.unit === 'piece';
}

function isSalad(recipe) {
  return Array.isArray(recipe?.tags) && recipe.tags.includes('salad');
}

function trendCalorieRatio(recipe, servingTime, weightTrend) {
  const pieceBased = isPieceBased(recipe);
  const inScope = pieceBased || TREND_SCOPED_SLOTS.has(servingTime);
  if (!inScope) return 1;

  const isLoss = weightTrend === 'loss';
  if (pieceBased) return isLoss ? 0.5 : 1;

  const baseQuantity = recipe?.servingSize?.quantity > 0 ? recipe.servingSize.quantity : 1;
  const target = isSalad(recipe) ? (isLoss ? 100 : 180) : isLoss ? 75 : 125;
  return target / baseQuantity;
}

function validateDietPlan({ parsedPlan, recipePool, calorieStrategy, weightTrend = 'gain' }) {
  const warnings = [];
  const recipeById = new Map((recipePool || []).map((r) => [r.id, r]));
  const weeks = Array.isArray(parsedPlan?.weeks) ? parsedPlan.weeks : [];
  const weeksSummaryComputed = [];

  for (const week of weeks) {
    const dailyMeals = Array.isArray(week?.dailyMeals) ? week.dailyMeals : [];

    // A week no longer has one "daily calories" figure - each of the 4
    // day-groups (Monday/Tuesday/Wednesday/Thursday, see dayGroups.js) has
    // its own distinct meals, so totals/deviation are tracked per group.
    const totalsByDayGroup = {};
    DAY_GROUPS.forEach((dg) => {
      totalsByDayGroup[dg] = { totalCalories: 0, totalProtein: 0, totalCarbs: 0, totalFats: 0 };
    });

    for (const meal of dailyMeals) {
      const recipe = recipeById.get(meal?.recipeId);

      if (!recipe) {
        warnings.push(
          `Week ${week?.week}: ${meal?.servingTime || 'a meal'} references recipe "${meal?.recipeId}" which is not in the allowed recipe pool - please reselect it manually.`
        );
        continue;
      }

      // Side/salad recipes are natively tagged with one servingTime (e.g.
      // Chapati is 'Lunch') but legitimately accompany Lunch, Dinner, and
      // Evening Snack too (see dietPlanOptions.js's identical exception) -
      // without this, every AI-composed combo would false-flag its own
      // sides as mismatched.
      const isSideOrSalad = Array.isArray(recipe.tags) && recipe.tags.some((t) => t === 'side' || t === 'salad');
      const isCrossListedSlot = isSideOrSalad && SIDE_SALAD_ELIGIBLE_SLOTS.has(meal.servingTime);
      if (
        meal.servingTime &&
        recipe.servingTime &&
        meal.servingTime !== recipe.servingTime &&
        !isCrossListedSlot
      ) {
        warnings.push(
          `Week ${week?.week}: "${recipe.name}" is a ${recipe.servingTime} recipe but was assigned to ${meal.servingTime}.`
        );
      }

      const dayGroupTotals = totalsByDayGroup[meal?.dayGroup];
      if (!dayGroupTotals) {
        warnings.push(
          `Week ${week?.week}: ${meal?.servingTime || 'a meal'} has an invalid or missing dayGroup "${meal?.dayGroup}" - must be one of ${DAY_GROUPS.join(', ')}.`
        );
        continue;
      }

      const ratio = trendCalorieRatio(recipe, meal.servingTime, weightTrend);
      dayGroupTotals.totalCalories += (recipe.calories || 0) * ratio;
      dayGroupTotals.totalProtein += (recipe.protein || 0) * ratio;
      dayGroupTotals.totalCarbs += (recipe.carbs || 0) * ratio;
      dayGroupTotals.totalFats += (recipe.fats || 0) * ratio;
    }

    // Weekly summary = sum across all 4 groups (a rough "everything this
    // week" aggregate) - kept for response-shape compatibility; the real
    // deviation check below is per-day-group.
    const weekTotals = Object.values(totalsByDayGroup).reduce(
      (acc, t) => ({
        totalCalories: acc.totalCalories + t.totalCalories,
        totalProtein: acc.totalProtein + t.totalProtein,
        totalCarbs: acc.totalCarbs + t.totalCarbs,
        totalFats: acc.totalFats + t.totalFats,
      }),
      { totalCalories: 0, totalProtein: 0, totalCarbs: 0, totalFats: 0 }
    );

    weeksSummaryComputed.push({
      week: week?.week,
      totalCalories: Math.round(weekTotals.totalCalories),
      totalProtein: Math.round(weekTotals.totalProtein),
      totalCarbs: Math.round(weekTotals.totalCarbs),
      totalFats: Math.round(weekTotals.totalFats),
    });

    const calorieBudget = calorieStrategy?.calorieBudget;
    if (typeof calorieBudget === 'number' && calorieBudget > 0) {
      DAY_GROUPS.forEach((dayGroup) => {
        const dayTotalCalories = totalsByDayGroup[dayGroup].totalCalories;
        if (dayTotalCalories <= 0) return;
        const deviation = Math.abs(dayTotalCalories - calorieBudget) / calorieBudget;
        if (deviation > CALORIE_DEVIATION_TOLERANCE) {
          warnings.push(
            `Week ${week?.week}, ${dayGroup}: total daily calories (${Math.round(
              dayTotalCalories
            )}) deviate more than ${Math.round(
              CALORIE_DEVIATION_TOLERANCE * 100
            )}% from the target budget (${calorieBudget}).`
          );
        }
      });
    }
  }

  return {
    valid: warnings.length === 0,
    warnings,
    weeksSummaryComputed,
  };
}

module.exports = { validateDietPlan, CALORIE_DEVIATION_TOLERANCE };
