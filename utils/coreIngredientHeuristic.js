// Deterministic (no AI call) implementation of the recipe-core-ingredient-
// scaling category-priority heuristic - see models/Recipe.js's `role`
// field comment and openspec/changes/recipe-core-ingredient-scaling for
// the full rationale. Used only where there's no model judgment to defer
// to: correcting an AI-generated recipe that came back with zero `core`
// ingredients (utils/openaiClient.js), and defaulting a manually-authored
// recipe's core ingredient(s) when a dietician's create/update request
// doesn't mark any `role` at all (controllers/dietician/uploadRecipieController.js).
// Deliberately NOT used to override a non-zero AI-generated `role` split -
// see design.md's Decisions for why the model's own judgment is trusted
// there even when it doesn't match this mechanical rule exactly.

// Highest to lowest priority, exactly the same 14 categories as
// utils/recipeJsonSchema.js's INGREDIENT_CATEGORIES (kept as a flat total
// order, not tiers, so "the single highest-priority category present" has
// one unambiguous answer even for a dish spanning multiple early
// categories, e.g. a Khichdi with both a Grain and a Legume ingredient).
const CORE_CATEGORY_PRIORITY = [
  'Grain', 'Carbohydrate', 'Protein Rich', 'Legume',
  'Dairy', 'Vegetable', 'Fruit', 'Nut/Seed',
  'Spice', 'Oil/Fat', 'Sweetener', 'Herb', 'Sauce/Condiment', 'Other',
];

/**
 * Returns a NEW array (never mutates the input) with every ingredient's
 * `role` set: every ingredient sharing the single highest-priority
 * category actually present gets 'core', everything else gets 'sub'. An
 * ingredient with a missing/unrecognized `category` is treated as 'Other'
 * (lowest priority) for this decision only, matching the same fallback
 * convention already used when ingredients are finalized elsewhere (see
 * openaiClient.js's perServingIngredients mapping).
 *
 * Empty/non-array input is returned as-is - nothing to decide.
 */
function applyCoreIngredientHeuristic(ingredients) {
  if (!Array.isArray(ingredients) || ingredients.length === 0) return ingredients || [];

  const categoryOf = (ing) =>
    CORE_CATEGORY_PRIORITY.includes(ing?.category) ? ing.category : 'Other';

  const presentCategories = new Set(ingredients.map(categoryOf));
  const coreCategory = CORE_CATEGORY_PRIORITY.find((cat) => presentCategories.has(cat));

  return ingredients.map((ing) => ({
    ...ing,
    role: categoryOf(ing) === coreCategory ? 'core' : 'sub',
  }));
}

/** True if at least one ingredient already has `role: 'core'`. */
function hasCoreIngredient(ingredients) {
  return Array.isArray(ingredients) && ingredients.some((ing) => ing?.role === 'core');
}

module.exports = {
  CORE_CATEGORY_PRIORITY,
  applyCoreIngredientHeuristic,
  hasCoreIngredient,
};
