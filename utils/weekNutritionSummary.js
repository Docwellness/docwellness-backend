// Monday's meals repeat on Friday, Tuesday's on Saturday, Wednesday's on
// Sunday - Thursday is unique (see dayGroups.js).
const DAYS_REPRESENTED_BY_DAY_GROUP = { Monday: 2, Tuesday: 2, Wednesday: 2, Thursday: 1 };

/**
 * Computes the day-group-weighted 7-day average calories/protein/carbs/fat/
 * fiber for a finalized week's selected meals - the single authoritative
 * formula, mirrored client-side in the dietician app's
 * PatientsController._weightedWeekTotals (kept there too, for the live
 * "Total Budget" preview while editing - this is the version that actually
 * gets stored). Recomputed here from each recipe's *current* nutrition data
 * (fetched by id, not trusted from the client's submitted summary), so:
 *   - the dietician's live preview, the stored weeksSummary, and what the
 *     patient app reads back can never drift out of sync with each other
 *   - a later recipe correction (e.g. a wrong calorie count fixed) is
 *     reflected the next time this week is finalized, instead of freezing
 *     in whatever was true at the original finalize time
 *
 * @param {Array<{dayGroup, servingTime, recipeId, servings, secondaryServings?}>} meals
 * @param {Array} recipeDocs - Recipe documents (must include nutrition,
 *   servingSize, secondaryComponent, category) for every recipeId in meals
 */
function computeWeekSummary(meals, recipeDocs) {
  const recipesById = {};
  recipeDocs.forEach((r) => {
    recipesById[r._id.toString()] = r;
  });

  const byDayGroup = { calories: {}, fat: {}, carbs: {}, protein: {}, fiber: {} };

  meals.forEach((meal) => {
    const recipe = recipesById[meal.recipeId?.toString()];
    // Supplements carry real supplementFacts now, not meaningful calorie/
    // macro numbers (their nutrition is intentionally zeroed server-side) -
    // excluded so the budget reflects food only, by construction.
    if (!recipe || recipe.category === 'Supplements') return;

    const baseQty = recipe.servingSize?.quantity || 1;
    const primaryRatio = baseQty ? (meal.servings ?? baseQty) / baseQty : 1;
    let ratio = primaryRatio;
    if (
      recipe.secondaryComponent &&
      meal.secondaryServings !== undefined &&
      meal.secondaryServings !== null
    ) {
      const secondaryBaseQty = recipe.secondaryComponent.quantity || 1;
      const secondaryRatio = secondaryBaseQty
        ? meal.secondaryServings / secondaryBaseQty
        : 1;
      ratio = (primaryRatio + secondaryRatio) / 2;
    }

    const dg = meal.dayGroup;
    const nutrition = recipe.nutrition || {};
    byDayGroup.calories[dg] = (byDayGroup.calories[dg] || 0) + (nutrition.calories || 0) * ratio;
    byDayGroup.fat[dg] = (byDayGroup.fat[dg] || 0) + (nutrition.fats || 0) * ratio;
    byDayGroup.carbs[dg] = (byDayGroup.carbs[dg] || 0) + (nutrition.carbs || 0) * ratio;
    byDayGroup.protein[dg] = (byDayGroup.protein[dg] || 0) + (nutrition.protein || 0) * ratio;
    byDayGroup.fiber[dg] = (byDayGroup.fiber[dg] || 0) + (nutrition.fiber || 0) * ratio;
  });

  let weekCalories = 0;
  let weekFat = 0;
  let weekCarbs = 0;
  let weekProtein = 0;
  let weekFiber = 0;
  Object.entries(DAYS_REPRESENTED_BY_DAY_GROUP).forEach(([dayGroup, days]) => {
    weekCalories += (byDayGroup.calories[dayGroup] || 0) * days;
    weekFat += (byDayGroup.fat[dayGroup] || 0) * days;
    weekCarbs += (byDayGroup.carbs[dayGroup] || 0) * days;
    weekProtein += (byDayGroup.protein[dayGroup] || 0) * days;
    weekFiber += (byDayGroup.fiber[dayGroup] || 0) * days;
  });

  return {
    totalCalories: Math.round(weekCalories / 7),
    fatGrams: Math.round(weekFat / 7),
    carbGrams: Math.round(weekCarbs / 7),
    proteinGrams: Math.round(weekProtein / 7),
    fiberGrams: Math.round(weekFiber / 7),
  };
}

module.exports = { computeWeekSummary };
