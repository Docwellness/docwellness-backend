const { DAY_GROUPS } = require('./dayGroups');

/**
 * Single seam for reading a DietPlan's finalized/draft weeks. Every call
 * site across the app used to inline
 * `Array.isArray(dietPlan.finalizedPlan?.weeks) ? dietPlan.finalizedPlan.weeks : []`
 * (and the draftPlan equivalent) directly - now they all call the functions
 * below instead.
 *
 * getFinalizedWeeks/getDraftWeeks are today a pure passthrough to the legacy
 * finalizedPlan/draftPlan blobs (models/DietPlan.js) - zero behavior change
 * from before this file existed. Once scripts/migrate-diet-plan-typed-
 * schema.js has populated `days[]` for every plan, these two functions
 * become the one place that switches from reading the legacy blob to
 * deriving the equivalent shape from `days[]` via buildLegacyWeeksView below
 * - every caller stays unchanged either way.
 *
 * applyLegacyWeekPayload/buildLegacyWeeksView convert between the legacy
 * `{week, dailyMeals: [{dayGroup, servingTime, recipeId, servings,
 * secondaryServings?, componentServings?}]}` shape and the typed `days[]`
 * subdocument shape (models/DietPlan.js). Only the main food items round-trip
 * - supplements aren't part of finalizedPlan/draftPlan today (see
 * dietPlanOptions.js's SUPPLEMENTS_PSEUDO_SLOT, handled entirely outside
 * dailyMeals[]), so a day converted from legacy data always has an empty
 * `supplements[]` until it's edited through the new supplement-injection
 * endpoints (Phase 3).
 */

function getFinalizedWeeks(dietPlan) {
  return Array.isArray(dietPlan?.finalizedPlan?.weeks) ? dietPlan.finalizedPlan.weeks : [];
}

function getDraftWeeks(dietPlan) {
  return Array.isArray(dietPlan?.draftPlan?.weeks) ? dietPlan.draftPlan.weeks : [];
}

/**
 * Converts one legacy week payload ({week, dailyMeals}) into `days[]`
 * subdocument entries (one per dayGroup actually present in dailyMeals).
 * Pure function - does not touch dietPlan.days itself, see
 * applyLegacyWeekPayload for the mutating version used by writers.
 */
function daysFromLegacyWeekPayload({ week, dailyMeals }) {
  const mealsByDayGroup = new Map();

  for (const meal of Array.isArray(dailyMeals) ? dailyMeals : []) {
    if (!meal || !DAY_GROUPS.includes(meal.dayGroup) || !meal.recipeId) continue;
    if (!mealsByDayGroup.has(meal.dayGroup)) mealsByDayGroup.set(meal.dayGroup, new Map());
    const slotsForDay = mealsByDayGroup.get(meal.dayGroup);
    if (!slotsForDay.has(meal.servingTime)) slotsForDay.set(meal.servingTime, []);

    let componentServings;
    if (Array.isArray(meal.componentServings) && meal.componentServings.length > 0) {
      componentServings = meal.componentServings;
    } else if (typeof meal.secondaryServings === 'number') {
      componentServings = [meal.servings ?? 1, meal.secondaryServings];
    }

    slotsForDay.get(meal.servingTime).push({
      recipeId: meal.recipeId,
      servingMultiplier: typeof meal.servings === 'number' && meal.servings > 0 ? meal.servings : 1,
      ...(componentServings ? { componentServings } : {}),
      locked: false,
      isLinkedComponent: false,
      parentRecipeId: null,
      swapHistory: [],
      calculatedNutrition: { calories: null, protein: null, carbs: null, fats: null, fiber: null },
      displayText: null,
    });
  }

  return [...mealsByDayGroup.entries()].map(([dayGroup, slotsForDay]) => ({
    week,
    dayGroup,
    meals: [...slotsForDay.entries()].map(([servingTime, items]) => ({
      servingTime,
      items,
      supplements: [],
    })),
  }));
}

/**
 * Upserts one legacy week payload into dietPlan.days (in place - dietPlan
 * must still be saved by the caller). Mirrors the existing
 * finalizeWeekPlan/saveDraftWeek upsert-by-week-number semantics: any
 * existing `days[]` entries for this week are fully replaced (not merged),
 * matching how finalizedPlan.weeks[existingIndex] = weekPayload already
 * replaces the whole week wholesale.
 */
function applyLegacyWeekPayload(dietPlan, weekPayload) {
  if (!Array.isArray(dietPlan.days)) dietPlan.days = [];
  const week = weekPayload.week;
  dietPlan.days = dietPlan.days.filter((d) => d.week !== week);
  dietPlan.days.push(...daysFromLegacyWeekPayload(weekPayload));
  dietPlan.markModified('days');
}

/**
 * Inverse of applyLegacyWeekPayload: derives the legacy `{weeks:[{week,
 * dailyMeals}]}` shape from dietPlan.days. Used by the migration script's
 * --verify mode (round-trip no-data-loss check) and, after cutover, by
 * getFinalizedWeeks/getDraftWeeks themselves.
 */
function buildLegacyWeeksView(dietPlan) {
  const days = Array.isArray(dietPlan?.days) ? dietPlan.days : [];
  const weekNumbers = [...new Set(days.map((d) => d.week))].sort((a, b) => a - b);

  const weeks = weekNumbers.map((week) => {
    const dailyMeals = [];
    for (const day of days.filter((d) => d.week === week)) {
      for (const meal of day.meals || []) {
        for (const item of meal.items || []) {
          const entry = {
            dayGroup: day.dayGroup,
            servingTime: meal.servingTime,
            recipeId: item.recipeId?.toString ? item.recipeId.toString() : item.recipeId,
            servings: item.servingMultiplier ?? 1,
          };
          if (Array.isArray(item.componentServings) && item.componentServings.length > 0) {
            entry.componentServings = item.componentServings;
            if (item.componentServings.length === 2) {
              entry.secondaryServings = item.componentServings[1];
            }
          }
          dailyMeals.push(entry);
        }
      }
    }
    return { week, dailyMeals };
  });

  return { weeks };
}

module.exports = {
  getFinalizedWeeks,
  getDraftWeeks,
  applyLegacyWeekPayload,
  buildLegacyWeeksView,
  daysFromLegacyWeekPayload,
};
