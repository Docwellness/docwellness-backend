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

/**
 * Deterministic backstop for updateRecipeFromEdits's structured ingredient
 * editor (add/edit/remove via UpdateAiInputsSheet - distinct from the
 * free-text aiNote this module's other functions guard). Previously,
 * `generateRecipeWithAI`'s regenerated `ingredients` array replaced the
 * dietician's submitted list wholesale - so a single, precise edit (e.g.
 * "Amla Juice" 30ml -> 20ml) could come back with that ingredient silently
 * renamed, unit-converted ("2 piece" instead of "20 ml"), or dropped
 * entirely, because the model re-derives the whole list from the prompt
 * rather than diffing against what was submitted. A dietician's structural
 * edit - the ingredient's `name`/`quantity`/`unit` - is not a suggestion for
 * the model to reinterpret; it's the literal value they just set via the
 * editor, so it's preserved verbatim here for every submitted ingredient,
 * matched by name to the model's response only to inherit AI-filled
 * metadata (category/priceLevel/description/image/isScalable). `role` is
 * also preserved verbatim - it's set by the dietician's own Core/Sub toggle,
 * not something the model should second-guess.
 *
 * A genuinely NEW ingredient the model added (name doesn't match any
 * submitted one - e.g. in response to an aiNote like "add ginger for
 * digestion") is kept as the model returned it. An ingredient never
 * silently disappears: every submitted ingredient is guaranteed to appear
 * in the result. (A dietician-requested removal, e.g. "remove the honey" in
 * aiNote, isn't guarded against here - that's simply not resubmitting that
 * ingredient in the first place, via the "-" button in the editor.)
 *
 * Downstream, applyAiNoteQuantityOverrides still runs on the result and can
 * still adjust a preserved ingredient's quantity/unit if the dietician's
 * aiNote text explicitly mentions it - this function only protects against
 * the model's own unprompted reinterpretation, not an intentional
 * note-driven change.
 */
function preserveSubmittedIngredients(submittedIngredients, aiIngredients) {
  const submitted = Array.isArray(submittedIngredients) ? submittedIngredients : [];
  const aiList = Array.isArray(aiIngredients) ? aiIngredients : [];

  // Same lenient collapsed-letter-run containment check
  // applyAiNoteQuantityOverrides uses (see its own comment) - the model
  // doesn't just reorder ingredients, it can rename them too (the reported
  // bug: submitted "Amla Juice" came back as "Amla"), so an exact-string
  // match would treat that as a brand new, unrelated ingredient rather
  // than the same one the dietician already specified.
  const collapse = (s) => String(s || '').toLowerCase().replace(/[^a-z]/g, '');
  const findAiMatch = (subName) => {
    const collapsedSub = collapse(subName);
    if (!collapsedSub) return null;
    return aiList.find((ing) => {
      const collapsedAi = collapse(ing?.name);
      return (
        collapsedAi.length > 0 &&
        (collapsedSub.includes(collapsedAi) || collapsedAi.includes(collapsedSub))
      );
    });
  };

  const matchedAiIngredients = new Set();
  const merged = submitted.map((sub) => {
    const aiMatch = findAiMatch(sub?.name);
    if (aiMatch) matchedAiIngredients.add(aiMatch);
    return {
      name: sub.name,
      quantity: sub.quantity,
      unit: sub.unit || 'g',
      category: aiMatch?.category || sub.category || 'Other',
      priceLevel: aiMatch?.priceLevel || sub.priceLevel || '₹₹',
      description: (aiMatch?.description ?? sub.description) || '',
      isScalable: (aiMatch ? aiMatch.isScalable : sub.isScalable) !== false,
      image: sub.image || aiMatch?.image || null,
      role: sub.role === 'core' ? 'core' : 'sub',
    };
  });

  const addedByModel = aiList
    .filter((ing) => !matchedAiIngredients.has(ing))
    .map((ing) => ({
      name: ing.name,
      quantity: ing.quantity,
      unit: ing.unit || 'g',
      category: ing.category || 'Other',
      priceLevel: ing.priceLevel || '₹₹',
      description: ing.description || '',
      isScalable: ing.isScalable !== false,
      image: ing.image || null,
      role: ing.role === 'core' ? 'core' : 'sub',
    }));

  return [...merged, ...addedByModel];
}

module.exports = {
  parseQuantitiesFromNote,
  applyAiNoteQuantityOverrides,
  enforceFiniteIngredientQuantities,
  preserveSubmittedIngredients,
};
