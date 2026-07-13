// Deterministic backstop for aiNote (Custom Ingredients/Preferences) quantity
// preservation. The prompt in openaiClient.js already instructs the model to
// treat dietician-stated quantities as authoritative (QUANTITY OVERRIDE RULE),
// but that's still a probabilistic instruction - this module re-derives the
// dietician's literal quantities from the note text and overwrites whatever
// the model actually returned, so the guarantee doesn't depend on the model
// following instructions correctly every time. Mirrors the plain-exported-
// function style of dietaryConstraintValidator.js.

const FRACTION_MAP = {
  '½': 0.5, '¼': 0.25, '¾': 0.75,
  '⅓': 1 / 3, '⅔': 2 / 3,
  '⅛': 0.125, '⅜': 0.375, '⅝': 0.625, '⅞': 0.875,
};

const UNIT_SYNONYMS = {
  tbs: 'tbsp', tbsp: 'tbsp', tablespoon: 'tbsp', tablespoons: 'tbsp',
  tsp: 'tsp', teaspoon: 'tsp', teaspoons: 'tsp',
  cup: 'cup', cups: 'cup',
  g: 'g', gram: 'g', grams: 'g',
  ml: 'ml', milliliter: 'ml', milliliters: 'ml',
  piece: 'piece', pieces: 'piece', pc: 'piece',
};

const FRACTION_CHARS = Object.keys(FRACTION_MAP).join('');

// Matches a leading quantity token: whole number, decimal, mixed number with a
// unicode fraction ("1½" or "1 ½"), a bare unicode fraction ("½"), or a plain
// fraction ("1/2").
const QUANTITY_PATTERN = `(?:\\d+\\.\\d+|\\d+\\s*[${FRACTION_CHARS}]|[${FRACTION_CHARS}]|\\d+\\/\\d+|\\d+)`;
const UNIT_PATTERN = Object.keys(UNIT_SYNONYMS).join('|');

const TOKEN_REGEX = new RegExp(
  `(${QUANTITY_PATTERN})\\s*(${UNIT_PATTERN})?\\s+([a-zA-Z][a-zA-Z\\s]{1,40}?)(?=[,;.\\n\\-]|$)`,
  'gi'
);

function parseQuantityToken(token) {
  const trimmed = token.trim();
  if (trimmed.includes('/')) {
    const [numStr, denStr] = trimmed.split('/');
    const num = parseFloat(numStr);
    const den = parseFloat(denStr);
    if (!Number.isNaN(num) && !Number.isNaN(den) && den !== 0) return num / den;
  }
  // Mixed number with unicode fraction, e.g. "1½" or "1 ½"
  const mixedMatch = trimmed.match(new RegExp(`^(\\d+)\\s*([${FRACTION_CHARS}])$`));
  if (mixedMatch) {
    return parseInt(mixedMatch[1], 10) + FRACTION_MAP[mixedMatch[2]];
  }
  // Bare unicode fraction
  if (FRACTION_MAP[trimmed] !== undefined) return FRACTION_MAP[trimmed];
  const parsed = parseFloat(trimmed);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Best-effort extraction of { ingredientToken, quantity, unit } tuples from a
 * dietician's free-text Custom Ingredients/Preferences note. Handles bulleted/
 * multi-line notes, unicode fractions, mixed numbers, and the schema's unit
 * vocabulary. Tokens that don't match a recognizable quantity+ingredient
 * pattern are simply skipped (falls back to the model's own judgment / the
 * prompt-level QUANTITY OVERRIDE RULE).
 */
function parseQuantitiesFromNote(aiNote) {
  if (!aiNote || !aiNote.trim()) return [];

  const results = [];
  let match;
  TOKEN_REGEX.lastIndex = 0;
  while ((match = TOKEN_REGEX.exec(aiNote)) !== null) {
    const quantity = parseQuantityToken(match[1]);
    if (quantity === null) continue;

    const unit = match[2] ? UNIT_SYNONYMS[match[2].toLowerCase()] : null;
    const ingredientToken = match[3].trim().replace(/\s+/g, ' ');
    if (!ingredientToken) continue;

    results.push({ ingredientToken, quantity, unit });
  }

  return results;
}

/**
 * Overwrites quantity/unit on ingredients whose name matches a tuple parsed
 * from the dietician's note, guaranteeing their stated per-serving amount is
 * honored regardless of what the model returned. The matched per-serving
 * amount is multiplied by `servings` to stay consistent with every other
 * ingredient in the array (see openaiClient.js's deterministic servings-
 * scaling - all ingredient quantities in the final array represent the total
 * across all servings, not a single serving).
 *
 * Returns { ingredients, appliedOverrides } - appliedOverrides is for
 * server-side logging/monitoring (how often the model deviates from the
 * dietician's stated quantities), not necessarily surfaced to the dietician
 * since the corrected value is what they asked for.
 */
function applyAiNoteQuantityOverrides({ aiNote, ingredients, servings = 1 }) {
  const tuples = parseQuantitiesFromNote(aiNote);
  if (tuples.length === 0 || !Array.isArray(ingredients)) {
    return { ingredients: ingredients || [], appliedOverrides: [] };
  }

  // Whitespace/casing-insensitive comparison so "chick peas" (as a dietician
  // might type it) still matches the AI's standardized "Chickpeas" - collapse
  // both to a bare lowercase letter run and check containment either way.
  const collapse = (s) => (s || '').toLowerCase().replace(/[^a-z]/g, '');

  const appliedOverrides = [];
  const updatedIngredients = ingredients.map((ing) => {
    const name = ing.name || '';
    const escapedToken = (t) => t.ingredientToken.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const collapsedName = collapse(name);

    const tuple = tuples.find((t) => {
      const wordBoundaryMatch =
        new RegExp(`\\b${escapedToken(t)}\\b`, 'i').test(name) ||
        (name && new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(t.ingredientToken));
      if (wordBoundaryMatch) return true;

      const collapsedToken = collapse(t.ingredientToken);
      return (
        collapsedToken.length > 0 &&
        collapsedName.length > 0 &&
        (collapsedName.includes(collapsedToken) || collapsedToken.includes(collapsedName))
      );
    });

    if (!tuple) return ing;

    const finalQuantity = tuple.quantity * servings;
    const finalUnit = tuple.unit || ing.unit;
    if (ing.quantity === finalQuantity && ing.unit === finalUnit) return ing;

    appliedOverrides.push({
      ingredient: ing.name,
      from: { quantity: ing.quantity, unit: ing.unit },
      to: { quantity: finalQuantity, unit: finalUnit },
    });

    return { ...ing, quantity: finalQuantity, unit: finalUnit };
  });

  return { ingredients: updatedIngredients, appliedOverrides };
}

// Small, sensible per-serving defaults keyed by the ingredient's own
// `category` field (already assigned by the model) - used only as a last
// resort when the model still returned a non-positive/non-finite quantity
// despite the prompt's NO ZERO/PLACEHOLDER QUANTITIES RULE and the schema's
// `minimum` constraint. Not meant to be precise, just non-zero and plausible
// enough for a dietician to spot-correct via the surfaced warning.
const CATEGORY_FALLBACK_QUANTITY = {
  Spice: { quantity: 1, unit: 'g' },
  Herb: { quantity: 1, unit: 'g' },
  'Oil/Fat': { quantity: 1, unit: 'tsp' },
  Sweetener: { quantity: 1, unit: 'tsp' },
  'Sauce/Condiment': { quantity: 1, unit: 'tsp' },
  'Nut/Seed': { quantity: 5, unit: 'g' },
};
const DEFAULT_FALLBACK_QUANTITY = { quantity: 10, unit: 'g' };

/**
 * Deterministic final backstop: any ingredient the model still returned with
 * a non-positive or non-finite quantity (despite the prompt rule and schema
 * minimum) gets replaced with a small sensible default for its category,
 * rather than ever reaching the database as 0/NaN. Every correction is
 * returned in `corrections` for the caller to surface as a warning - never
 * applied silently.
 */
function enforceFiniteIngredientQuantities(ingredients) {
  if (!Array.isArray(ingredients)) return { ingredients: [], corrections: [] };

  const corrections = [];
  const fixedIngredients = ingredients.map((ing) => {
    const quantity = ing?.quantity;
    if (typeof quantity === 'number' && Number.isFinite(quantity) && quantity > 0) {
      return ing;
    }

    const fallback = CATEGORY_FALLBACK_QUANTITY[ing?.category] || DEFAULT_FALLBACK_QUANTITY;
    corrections.push({
      ingredient: ing?.name || '(unnamed ingredient)',
      from: quantity,
      to: fallback,
    });
    return { ...ing, quantity: fallback.quantity, unit: fallback.unit };
  });

  return { ingredients: fixedIngredients, corrections };
}

module.exports = {
  parseQuantitiesFromNote,
  applyAiNoteQuantityOverrides,
  enforceFiniteIngredientQuantities,
};
