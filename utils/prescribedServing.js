/**
 * What the patient is actually prescribed to eat for one RecipeVersion, as a
 * display label ("170 g", "2 piece", "3 nos + 1 bowl"), or null when no real
 * serving was computed. Null is a hard stop for the dietician (they must set
 * the serving before the plan can be finalized) - the patient app must never
 * be left to show a placeholder like "1 g".
 */

// Below this a g/ml total is a placeholder (the "1 g" default), not a dish.
const MIN_REALISTIC_MASS_OR_VOLUME = 5;
const MASS_OR_VOLUME_UNITS = new Set(['g', 'ml']);

const fmt = (n) => String(Math.round(n * 10) / 10);

/**
 * @param {Array<{quantity:number, unit:string}>} components - the version's
 *        whole-dish servings (or ingredient lines mapped to the same shape)
 */
function prescribedServingLabel(components) {
  const items = (components || []).filter(
    (c) => c && typeof c.quantity === 'number' && c.quantity > 0 && c.unit
  );
  if (!items.length) return null;

  const units = new Set(items.map((c) => c.unit));
  if (units.size === 1) {
    const unit = items[0].unit;
    const total = items.reduce((sum, c) => sum + c.quantity, 0);
    if (MASS_OR_VOLUME_UNITS.has(unit) && total < MIN_REALISTIC_MASS_OR_VOLUME) return null;
    return `${fmt(total)} ${unit}`;
  }
  return items.map((c) => `${fmt(c.quantity)} ${c.unit}`).join(' + ');
}

/** Label for a RecipeVersion document: components first, ingredients as the fallback. */
function prescribedServingLabelForVersion(version) {
  const fromComponents = prescribedServingLabel(version?.components);
  if (fromComponents) return fromComponents;
  return prescribedServingLabel(
    (version?.ingredients || []).map((ing) => ({ quantity: ing.rawQuantity ?? ing.quantity, unit: ing.unit }))
  );
}

module.exports = { MIN_REALISTIC_MASS_OR_VOLUME, prescribedServingLabel, prescribedServingLabelForVersion };
