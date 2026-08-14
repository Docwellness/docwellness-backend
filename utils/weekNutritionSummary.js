// Monday's meals repeat on Friday, Tuesday's on Saturday, Wednesday's on
// Sunday - Thursday is unique (see dayGroups.js).
const DAYS_REPRESENTED_BY_DAY_GROUP = { Monday: 2, Tuesday: 2, Wednesday: 2, Thursday: 1 };

// A recipe predating the `components` migration (or a not-yet-run
// migration) still only has servingSize/secondaryComponent - synthesize an
// equivalent components list from those so computeMealRatio below has one
// code path regardless of which shape a given recipe doc is in. Mirrors
// scripts/migrate-recipe-components.js's own derivation.
function componentsForRecipe(recipe) {
  if (Array.isArray(recipe.components) && recipe.components.length > 0) {
    return recipe.components;
  }
  const derived = [];
  if (recipe.servingSize?.quantity > 0) {
    derived.push({ quantity: recipe.servingSize.quantity, unit: recipe.servingSize.unit });
  }
  if (recipe.secondaryComponent?.quantity > 0) {
    derived.push({ quantity: recipe.secondaryComponent.quantity, unit: recipe.secondaryComponent.unit });
  }
  return derived.length > 0 ? derived : [{ quantity: 1, unit: 'g' }];
}

/**
 * The ratio used to scale a recipe's total nutrition for one meal selection -
 * the average of each component's (selected quantity / recipe's own base
 * quantity), generalizing the old fixed primary+secondary average to
 * however many components the recipe actually has. A component with no
 * explicit selection for it (meal wasn't adjusted, or predates this
 * component existing) defaults to its own base quantity, i.e. ratio 1 for
 * that component - unchanged from how an untouched secondary component
 * used to behave.
 *
 * Reads per-component quantities from `meal.componentServings` (array,
 * same order as recipe.components) when present; falls back to the legacy
 * `meal.servings`/`meal.secondaryServings` (component 0 / component 1
 * only) for meals saved before this field existed.
 */
function computeMealRatio(meal, recipe) {
  const components = componentsForRecipe(recipe);
  const componentServings = Array.isArray(meal.componentServings) ? meal.componentServings : null;

  const ratios = components.map((component, index) => {
    const baseQty = component.quantity > 0 ? component.quantity : 1;
    let selectedQty;
    if (componentServings && typeof componentServings[index] === 'number' && componentServings[index] > 0) {
      selectedQty = componentServings[index];
    } else if (index === 0 && typeof meal.servings === 'number') {
      selectedQty = meal.servings;
    } else if (index === 1 && typeof meal.secondaryServings === 'number' && meal.secondaryServings !== null) {
      selectedQty = meal.secondaryServings;
    } else {
      selectedQty = baseQty;
    }
    return selectedQty / baseQty;
  });

  return ratios.reduce((sum, r) => sum + r, 0) / ratios.length;
}

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
 * @param {Array<{dayGroup, servingTime, recipeId, servings, secondaryServings?, componentServings?}>} meals
 * @param {Array} recipeDocs - Recipe documents (must include nutrition,
 *   components (or the legacy servingSize/secondaryComponent), category)
 *   for every recipeId in meals
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

    const ratio = computeMealRatio(meal, recipe);

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

/**
 * Per-component ratios keyed by the component's label (lowercased/trimmed),
 * for scaling an individual ingredient's grocery-list quantity by whichever
 * component it corresponds to - unlike computeMealRatio's single averaged
 * ratio (meant for whole-recipe nutrition scaling), each ingredient should
 * scale by its OWN matching component's servings, not the recipe-wide
 * average (e.g. a recipe where only the bread was bumped to 2 slices
 * shouldn't inflate the peanut butter's grocery quantity too). Same
 * label<->ingredient-name matching convention as the dietician app's
 * RecipePreview._syncedIngredients (recipe_model.dart) uses for its own
 * "Edit Portions" -> Ingredients tab sync.
 */
function componentRatiosByLabel(meal, recipe) {
  const components = componentsForRecipe(recipe);
  const componentServings = Array.isArray(meal.componentServings) ? meal.componentServings : null;
  const ratios = {};
  components.forEach((component, index) => {
    const baseQty = component.quantity > 0 ? component.quantity : 1;
    let selectedQty;
    if (componentServings && typeof componentServings[index] === 'number' && componentServings[index] > 0) {
      selectedQty = componentServings[index];
    } else if (index === 0 && typeof meal.servings === 'number') {
      selectedQty = meal.servings;
    } else if (index === 1 && typeof meal.secondaryServings === 'number' && meal.secondaryServings !== null) {
      selectedQty = meal.secondaryServings;
    } else {
      selectedQty = baseQty;
    }
    if (component.label) {
      ratios[component.label.trim().toLowerCase()] = selectedQty / baseQty;
    }
  });
  return ratios;
}

module.exports = { computeWeekSummary, componentRatiosByLabel };
