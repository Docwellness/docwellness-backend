/**
 * Deterministic, non-blocking sanity check for AI-generated recipe nutrition:
 * catches severe undercounts like the "Chickpeas Salad" case (claimed 190
 * kcal for a dish whose own ingredients - a cup of quinoa, half an avocado,
 * a tablespoon of olive oil - summed to ~720 kcal on manual audit) by
 * comparing the claimed calories against a rough, category-based
 * ingredient-weight estimate.
 *
 * Deliberately approximate - this is a coarse plausibility check, not a
 * replacement for real per-ingredient nutrition data, so it only flags large
 * deviations and never blocks generation. Same soft-warn philosophy as the
 * diet-plan-level severe-calorie-deviation check in dietPlanValidator.js,
 * just applied to a single recipe's own ingredient list instead of a day's
 * worth of recipes vs. a patient's calorie budget.
 */

const { INGREDIENT_CATEGORIES } = require('./recipeJsonSchema');

// Rough, category-level calorie density (kcal per 100g). Ingredient
// categories are broad (see INGREDIENT_CATEGORIES above), so this trades
// precision for having *some* reference point across every ingredient
// without needing a full nutrition database. Legume/Grain default to
// raw/dry weight (~340-350 kcal/100g), matching how this app's recipes
// consistently record those quantities.
const CATEGORY_KCAL_PER_100G = {
  'Protein Rich': 180,
  Carbohydrate: 350,
  Vegetable: 30,
  Dairy: 65,
  Spice: 300,
  'Oil/Fat': 880,
  Sweetener: 350,
  Grain: 350,
  Legume: 340,
  'Nut/Seed': 580,
  Fruit: 55,
  Herb: 40,
  'Sauce/Condiment': 150,
  Other: 100,
};

// Universal unit -> grams approximation, for this rough estimate only (not
// ingredient-specific). "piece" is deliberately excluded - no generic
// weight is reliable enough not to mislead - so this estimate is a *lower
// bound* that undercounts whatever piece-based ingredients contribute.
// That's an acceptable, deliberate asymmetry: it makes the check good at
// catching claimed-calories-too-LOW (the motivating case), weaker at
// catching claimed-too-HIGH, rather than guessing a piece weight that could
// itself be wrong.
const UNIT_TO_GRAMS = {
  g: 1,
  ml: 1,
  tbsp: 15,
  tsp: 5,
  cup: 150,
};

// How far below the rough estimate a claimed calorie figure can fall before
// this flags it. Wide on purpose (the estimate is coarse, category-level,
// and already a strict lower bound), so only a genuinely severe mismatch
// trips it.
const SEVERE_UNDERCOUNT_RATIO = 0.5;

/**
 * Rough lower-bound calorie estimate for one serving's ingredient list.
 * Sums whichever ingredients have a g/ml/tbsp/tsp/cup unit (skips "piece"),
 * using each ingredient's own category as a calorie-density proxy.
 */
function estimateCaloriesFromIngredients(ingredients) {
  if (!Array.isArray(ingredients)) return 0;
  return ingredients.reduce((total, ing) => {
    const grams = UNIT_TO_GRAMS[ing?.unit];
    if (!grams || typeof ing?.quantity !== 'number') return total;
    const density = CATEGORY_KCAL_PER_100G[ing?.category] ?? CATEGORY_KCAL_PER_100G.Other;
    return total + (ing.quantity * grams * density) / 100;
  }, 0);
}

/**
 * Compares a recipe's claimed calories against the rough ingredient-based
 * estimate above. Returns a warning string (for the recipe's `warnings`
 * array - same non-blocking surface as the existing ingredient-quantity-
 * correction warnings) if the claim looks severely undercounted, or null if
 * it's plausible.
 */
function checkNutritionPlausibility({ ingredients, claimedCalories }) {
  const estimated = estimateCaloriesFromIngredients(ingredients);
  if (estimated <= 0 || typeof claimedCalories !== 'number') return null;

  if (claimedCalories < estimated * SEVERE_UNDERCOUNT_RATIO) {
    return (
      `Claimed calories (${Math.round(claimedCalories)}) look low for this ingredient list - ` +
      `a rough estimate from the ingredients alone suggests at least ~${Math.round(estimated)} kcal. ` +
      `Please double-check this recipe's nutrition before relying on it.`
    );
  }
  return null;
}

module.exports = { checkNutritionPlausibility, estimateCaloriesFromIngredients };
