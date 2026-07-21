// Deterministic post-generation checks for AI diet plans: verifies the model
// only referenced recipes it was actually given (closed-world check against
// recipePool), that servingTime slots match, and flags (non-blocking)
// calorie deviation from the requested strategy. Mirrors the role
// utils/dietaryConstraintValidator.js plays for individual recipes - the AI
// proposes, this catches drift deterministically, the dietician reviews.

const { SIDE_SALAD_ELIGIBLE_SLOTS, REQUIRED_SERVING_TIMES } = require('./dietPlanOptions');
const { DAY_GROUPS } = require('./dayGroups');

const CALORIE_DEVIATION_TOLERANCE = 0.1; // ±10%, per the architecture's tolerance-based reconciliation
// ±40% - a different regime from the soft tolerance above, not just a
// stricter version of it: 4x the soft threshold so ordinary estimation
// noise/portion variability never trips it, but a structurally broken
// generation (missing slots, wrong recipes) always does - e.g. the incident
// that motivated this: a plan totaling 151 kcal against a 1687 kcal budget,
// a ~91% deviation. Used to BLOCK (finalize-time) rather than just warn.
const SEVERE_CALORIE_DEVIATION_TOLERANCE = 0.4;

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
  const severeIssues = [];
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
        const message = `Week ${week?.week}: ${meal?.servingTime || 'a meal'} references recipe "${meal?.recipeId}" which is not in the allowed recipe pool - please reselect it manually.`;
        warnings.push(message);
        severeIssues.push({ type: 'unknown_recipe', week: week?.week, servingTime: meal?.servingTime, recipeId: meal?.recipeId, message });
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
        const message = `Week ${week?.week}: "${recipe.name}" is a ${recipe.servingTime} recipe but was assigned to ${meal.servingTime}.`;
        warnings.push(message);
        severeIssues.push({
          type: 'slot_mismatch',
          week: week?.week,
          recipeName: recipe.name,
          recipeServingTime: recipe.servingTime,
          assignedServingTime: meal.servingTime,
          message,
        });
      }

      const dayGroupTotals = totalsByDayGroup[meal?.dayGroup];
      if (!dayGroupTotals) {
        const message = `Week ${week?.week}: ${meal?.servingTime || 'a meal'} has an invalid or missing dayGroup "${meal?.dayGroup}" - must be one of ${DAY_GROUPS.join(', ')}.`;
        warnings.push(message);
        severeIssues.push({ type: 'invalid_day_group', week: week?.week, servingTime: meal?.servingTime, dayGroup: meal?.dayGroup, message });
        continue;
      }

      const ratio = trendCalorieRatio(recipe, meal.servingTime, weightTrend);
      dayGroupTotals.totalCalories += (recipe.calories || 0) * ratio;
      dayGroupTotals.totalProtein += (recipe.protein || 0) * ratio;
      dayGroupTotals.totalCarbs += (recipe.carbs || 0) * ratio;
      dayGroupTotals.totalFats += (recipe.fats || 0) * ratio;
    }

    // Every required slot must have at least one entry in every day-group -
    // catches the "silently missing slots" failure mode (e.g. the AI drops
    // most of Lunch/Dinner, collapsing the day's calorie total) that a
    // per-meal loop alone can't see, since it only inspects entries that
    // exist. Does not cap entries per slot - a legitimate 5-entry combo
    // (main + bread + rice + dal + salad) still passes.
    DAY_GROUPS.forEach((dayGroup) => {
      REQUIRED_SERVING_TIMES.forEach((servingTime) => {
        const hasEntry = dailyMeals.some((m) => m?.dayGroup === dayGroup && m?.servingTime === servingTime);
        if (!hasEntry) {
          const message = `Week ${week?.week}, ${dayGroup}: no meal entries found for required slot "${servingTime}".`;
          warnings.push(message);
          severeIssues.push({ type: 'missing_slot', week: week?.week, dayGroup, servingTime, message });
        }
      });
    });

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
        if (deviation > SEVERE_CALORIE_DEVIATION_TOLERANCE) {
          severeIssues.push({
            type: 'calorie_deviation_severe',
            week: week?.week,
            dayGroup,
            actualCalories: Math.round(dayTotalCalories),
            budgetCalories: calorieBudget,
            deviationPercent: Math.round(deviation * 100),
            message: `Week ${week?.week}, ${dayGroup}: total daily calories (${Math.round(
              dayTotalCalories
            )}) deviate ${Math.round(deviation * 100)}% from the target budget (${calorieBudget}) - exceeds the ${Math.round(
              SEVERE_CALORIE_DEVIATION_TOLERANCE * 100
            )}% severe threshold.`,
          });
        }
      });
    }
  }

  return {
    valid: warnings.length === 0,
    warnings,
    severeIssues,
    hasSevereIssues: severeIssues.length > 0,
    weeksSummaryComputed,
  };
}

// Turns the structured severeIssues from validateDietPlan into a short,
// specific corrective note appended to the next generation attempt's
// prompt (see openaiClient.js's correctiveNote param) - deduping repeated
// slot_mismatch entries per recipe (the AI misplacing "Chicken Curry" 6
// times becomes ONE bullet listing all 6 wrong slots) so the note stays
// short and doesn't drown the model in repetition. Capped so a badly broken
// plan can't blow up the next prompt's size.
const MAX_CORRECTIVE_NOTE_LINES = 15;

function formatSevereIssuesForPrompt(severeIssues) {
  const bySlotMismatchRecipe = new Map();
  const otherLines = [];

  (severeIssues || []).forEach((issue) => {
    if (issue.type === 'slot_mismatch') {
      const key = issue.recipeName;
      if (!bySlotMismatchRecipe.has(key)) {
        bySlotMismatchRecipe.set(key, { recipeServingTime: issue.recipeServingTime, wrongSlots: new Set() });
      }
      bySlotMismatchRecipe.get(key).wrongSlots.add(issue.assignedServingTime);
    } else {
      otherLines.push(`- ${issue.message}`);
    }
  });

  const slotMismatchLines = [...bySlotMismatchRecipe.entries()].map(
    ([name, { recipeServingTime, wrongSlots }]) =>
      `- "${name}" is a ${recipeServingTime} recipe - it was wrongly assigned to: ${[...wrongSlots].join(', ')}. Only use it for ${recipeServingTime}.`
  );

  return [...slotMismatchLines, ...otherLines].slice(0, MAX_CORRECTIVE_NOTE_LINES).join('\n');
}

module.exports = {
  validateDietPlan,
  formatSevereIssuesForPrompt,
  CALORIE_DEVIATION_TOLERANCE,
  SEVERE_CALORIE_DEVIATION_TOLERANCE,
};
