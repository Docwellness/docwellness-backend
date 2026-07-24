// Deterministic post-generation repair for a subset of validateDietPlan's
// severeIssues - the AI's own corrective-retry loop (see
// dietPlanController.js's runDietPlanGeneration) asks the model to fix its
// own mistakes, but in practice a model that broke the "only pick from
// this slot's candidate list" rule once often breaks it again in a
// different way on retry rather than reliably self-correcting. For the
// subset of issues that have one obvious, mechanical fix (drop the invalid
// entry, backfill the resulting gap from the same recipe pool the AI was
// given), doing that directly is faster and far more reliable than another
// full AI call - this is tried BEFORE spending a retry attempt, and only
// falls through to another AI call if something couldn't be repaired this
// way (e.g. every candidate in a slot's pool is somehow ineligible).
//
// Deliberately NOT repairable here: calorie_deviation_severe - fixing that
// would mean altering portions/composition across a whole day, not a
// single bad entry, so it stays on the AI corrective-retry path.

const { DAY_GROUPS, NON_VEG_ALLOWED_DAY_GROUPS } = require('./dayGroups');
const { REQUIRED_SERVING_TIMES, SIDE_SALAD_ELIGIBLE_SLOTS } = require('./dietPlanOptions');

const REPAIRABLE_SEVERE_ISSUE_TYPES = new Set([
  'missing_slot',
  'slot_mismatch',
  'unknown_recipe',
  'non_veg_on_vegetarian_day',
  'invalid_day_group',
]);

function isEntryStructurallyValid(meal, recipeById, { restrictNonVegToDayGroups }) {
  if (!DAY_GROUPS.includes(meal?.dayGroup)) return false;

  const recipe = recipeById.get(meal?.recipeId);
  if (!recipe) return false;

  const isSideOrSalad = Array.isArray(recipe.tags) && recipe.tags.some((t) => t === 'side' || t === 'salad');
  const isCrossListedSlot = isSideOrSalad && SIDE_SALAD_ELIGIBLE_SLOTS.has(meal.servingTime);
  if (meal.servingTime && recipe.servingTime && meal.servingTime !== recipe.servingTime && !isCrossListedSlot) {
    return false;
  }

  if (
    restrictNonVegToDayGroups &&
    recipe.dietaryHabits?.nonVegetarian === true &&
    !NON_VEG_ALLOWED_DAY_GROUPS.includes(meal.dayGroup)
  ) {
    return false;
  }

  return true;
}

// Picks whichever eligible recipe for this slot+dayGroup has been used
// least often elsewhere in the same week - best-effort variety for a
// backfilled entry, not a hard guarantee the way the AI's own "different
// main per day-group" instruction is.
function pickBackfillCandidate({ servingTime, dayGroup, recipePoolByServingTime, restrictNonVegToDayGroups, usageCounts }) {
  let candidates = recipePoolByServingTime[servingTime] || [];
  const mustBeVeg = restrictNonVegToDayGroups && !NON_VEG_ALLOWED_DAY_GROUPS.includes(dayGroup);
  if (mustBeVeg) {
    candidates = candidates.filter((r) => r.dietaryHabits?.nonVegetarian !== true);
  }
  if (candidates.length === 0) return null;

  let best = candidates[0];
  let bestCount = usageCounts.get(best.id) || 0;
  for (const candidate of candidates) {
    const count = usageCounts.get(candidate.id) || 0;
    if (count < bestCount) {
      best = candidate;
      bestCount = count;
    }
  }
  return best;
}

/**
 * @param parsedPlan  the AI's { weeks: [...] } output.
 * @param recipePool  flat array (recipeToPromptShape shape) - same one
 *   validateDietPlan uses for its closed-world check.
 * @param recipePoolByServingTime  { [servingTime]: recipe[] } - same shape
 *   passed into the prompt, used to source backfill candidates.
 * @param restrictNonVegToDayGroups  same flag threaded through
 *   validateDietPlan/buildPrompt for the Non-Vegetarian mixed-week rule.
 * @returns { repairedPlan, changesMade } - changesMade is a human-readable
 *   log of every removal/backfill, surfaced to the dietician as an
 *   informational validationWarning so a repaired plan is never silently
 *   different from what the AI actually produced.
 */
function repairStructuralIssues({ parsedPlan, recipePool, recipePoolByServingTime, restrictNonVegToDayGroups = false }) {
  const recipeById = new Map((recipePool || []).map((r) => [r.id, r]));
  const changesMade = [];
  const weeks = Array.isArray(parsedPlan?.weeks) ? parsedPlan.weeks : [];

  const repairedWeeks = weeks.map((week) => {
    const originalMeals = Array.isArray(week?.dailyMeals) ? week.dailyMeals : [];

    const validMeals = originalMeals.filter((meal) => {
      const ok = isEntryStructurallyValid(meal, recipeById, { restrictNonVegToDayGroups });
      if (!ok) {
        const recipeName = recipeById.get(meal?.recipeId)?.name || meal?.recipeId || 'unknown recipe';
        changesMade.push(
          `Week ${week.week}, ${meal?.dayGroup || '?'}: removed "${recipeName}" from ${meal?.servingTime || '?'} - not a valid choice for that slot.`
        );
      }
      return ok;
    });

    // Bias backfill picks away from recipes already used elsewhere this
    // week (mirrors the AI's own "different main per day-group" rule on a
    // best-effort basis).
    const usageCounts = new Map();
    validMeals.forEach((m) => {
      usageCounts.set(m.recipeId, (usageCounts.get(m.recipeId) || 0) + 1);
    });

    const repairedMeals = [...validMeals];
    DAY_GROUPS.forEach((dayGroup) => {
      REQUIRED_SERVING_TIMES.forEach((servingTime) => {
        const hasEntry = repairedMeals.some((m) => m.dayGroup === dayGroup && m.servingTime === servingTime);
        if (hasEntry) return;

        const candidate = pickBackfillCandidate({
          servingTime,
          dayGroup,
          recipePoolByServingTime,
          restrictNonVegToDayGroups,
          usageCounts,
        });
        if (!candidate) {
          changesMade.push(`Week ${week.week}, ${dayGroup}: could not backfill "${servingTime}" - no eligible recipe in the pool.`);
          return;
        }

        repairedMeals.push({ dayGroup, servingTime, recipeId: candidate.id });
        usageCounts.set(candidate.id, (usageCounts.get(candidate.id) || 0) + 1);
        changesMade.push(`Week ${week.week}, ${dayGroup}: filled missing "${servingTime}" with "${candidate.name}".`);
      });
    });

    return { ...week, dailyMeals: repairedMeals };
  });

  return { repairedPlan: { ...parsedPlan, weeks: repairedWeeks }, changesMade };
}

module.exports = { repairStructuralIssues, REPAIRABLE_SEVERE_ISSUE_TYPES };
