/**
 * "Is this recipe's real-world serving a thing you count, or a thing you
 * measure?" - the single source of truth for the diet-wizard-portions-and-
 * polish change's serving-size realism rules (openspec change
 * diet-wizard-portions-and-polish, capability diet-plan-wizard/portion-realism).
 *
 * A countable serving (a roti, an idli, an egg, a slice) must never be
 * auto-computed below 1, and always lands on a clean half-step - a diet
 * sheet that prescribes "0.58 piece Chapati" is not a real prescription.
 * A continuous serving (grams of dal, ml of a drink, a bowl of khichdi)
 * has no such constraint and is left alone.
 *
 * Classification is by the recipe version's SERVING COMPONENT unit
 * (RecipeVersion.components[0].unit), never its ingredient units - a
 * Chapati's flour is in grams, but the dish is served in pieces. A
 * multi-component dish (Idli + Sambar + Chutney) has no single serving to
 * floor, so it is treated as continuous, matching how the ingredient
 * editor already refuses "Makes (on the plate)" for multi-component recipes.
 *
 * Pure functions, no DB access - same convention as
 * nutritionCalculatorService.js.
 */

// A subset of utils/recipeJsonSchema.js's COMPONENT_UNITS. 'roti' is not a
// current COMPONENT_UNITS value but is kept here as forward-compat - if it
// is ever added, it is unambiguously countable.
const COUNTABLE_SERVING_UNITS = ['piece', 'nos', 'roti', 'slice', 'egg'];

/**
 * @param component  a RecipeVersion.components[] entry (or undefined) -
 *   typically components[0]. When the version has zero or more than one
 *   component, the caller should pass undefined / not call this per-component:
 *   a multi-component dish is never countable for flooring purposes.
 * @returns true only when `component` exists and its unit is a countable one.
 */
function isCountableServing(component) {
  if (!component || typeof component.unit !== 'string') return false;
  return COUNTABLE_SERVING_UNITS.includes(component.unit.trim().toLowerCase());
}

/**
 * Snaps a portion to the nearest 0.5 step (0.5, 1, 1.5, 2, ...) WITHOUT a
 * lower floor beyond 0.5 - used for a dietician's own manual "Makes (on the
 * plate)" edits, where half a roti is a legitimate prescription (the
 * patient app shows "½ piece" portions).
 */
function snapHalfStep(quantity) {
  const snapped = Math.round((Number(quantity) || 0) * 2) / 2;
  return Math.max(0.5, snapped);
}

/**
 * Floors a countable portion at 1 serving AND snaps it to the nearest 0.5
 * step (1, 1.5, 2, 2.5, ...). Never returns below 1 - used for auto-computed
 * portions (menu generation, auto-balance), never for a dietician's own
 * manual edit.
 */
function snapCountablePortion(quantity) {
  return Math.max(1, snapHalfStep(quantity));
}

module.exports = { COUNTABLE_SERVING_UNITS, isCountableServing, snapHalfStep, snapCountablePortion };
