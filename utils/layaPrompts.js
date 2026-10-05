/**
 * Prompt variants for the recipe -> serving-slot question, for
 * scripts/laya-prompt-ablation.js, and the protein question the production
 * request uses.
 *
 * Why variants exist: Laya runs on our own VM, so its "cost" is compute, and
 * compute is proportional to INPUT TOKENS (measured 2026-10-05: ~12 ms a token
 * on a laptop, ~29 ms a token on the production VM). The tokens are mostly the
 * question text, not the recipe: of the current 376-token request, the protein
 * question is ~138 and the seven slot descriptions ~106, while ingredients cost
 * only ~4 tokens each. So the question is how much of that text accuracy
 * actually needs. These variants strip it down in steps so the harness can
 * measure accuracy and tokens together.
 *
 * `current` is, by test, EXACTLY the request classifyRecipe sends in its default
 * (choice) mode, so the harness measures what production would do. Every
 * variant leaves the recipe's servingTime out (it would leak the answer).
 *
 * `approxInputTokens` are measured against a local Laya on 2026-10-05 (mean of
 * three recipes; `null` where not yet measured) and are only used to estimate
 * how long a run will take. The harness records the real figure per call.
 */

const { SLOTS, CHOICE_QUESTION_ID, buildSlotChoiceQuestion } = require('./layaSlots');

/** The protein tier question. Part of the production request, so defined once, here. */
function buildProteinQuestion() {
  return {
    protein_level: {
      type: 'choice',
      instructions:
        "Based on the ingredient list, how would you characterize this recipe's protein content relative to a typical dish of its type?",
      criteria: {
        low: 'Little to no significant protein source',
        moderate: 'A moderate protein contribution',
        high: 'A prominent protein source (e.g. meat, legumes, dairy, egg in quantity)',
      },
    },
  };
}

/** The slot question with the slots' NAMES as the only option text. */
function labelsOnlyQuestion() {
  return {
    [CHOICE_QUESTION_ID]: {
      type: 'choice',
      instructions: 'Which serving slot is this recipe best suited to?',
      criteria: Object.fromEntries(SLOTS.map((s) => [s.key, s.name])),
    },
  };
}

// A few words per slot: the middle ground between the full descriptions and bare names.
const SHORT_DESCRIPTIONS = {
  morning_drink: 'a drink taken early in the morning',
  breakfast: 'a morning meal',
  brunch: 'a late-morning meal',
  lunch: 'a midday meal',
  evening_snack: 'a light snack between lunch and dinner',
  dinner: 'an evening meal',
  night_drink: 'a drink taken before bed',
};
function shortDescriptionQuestion() {
  return {
    [CHOICE_QUESTION_ID]: {
      type: 'choice',
      instructions: 'Which serving slot is this recipe best suited to?',
      criteria: Object.fromEntries(SLOTS.map((s) => [s.key, SHORT_DESCRIPTIONS[s.key]])),
    },
  };
}

/** The recipe as Laya sees it. Same shape production uses; never includes servingTime. */
function recipeState(recipe, { maxIngredients = null } = {}) {
  const names = (recipe.ingredients || []).map((i) => i.name);
  return {
    name: recipe.name,
    cuisine: recipe.cuisine || null,
    category: recipe.category || null,
    ingredients: maxIngredients ? names.slice(0, maxIngredients) : names,
  };
}

const VARIANTS = [
  {
    id: 'current',
    label: 'Current: slots with descriptions + protein, all ingredients',
    approxInputTokens: 376,
    build: (r) => ({ state: recipeState(r), questions: { ...buildSlotChoiceQuestion(), ...buildProteinQuestion() } }),
  },
  {
    id: 'no_protein',
    label: 'Slots with descriptions, no protein',
    approxInputTokens: 238,
    build: (r) => ({ state: recipeState(r), questions: { ...buildSlotChoiceQuestion() } }),
  },
  {
    id: 'labels_protein',
    label: 'Slot names only (no descriptions) + protein',
    approxInputTokens: 270,
    build: (r) => ({ state: recipeState(r), questions: { ...labelsOnlyQuestion(), ...buildProteinQuestion() } }),
  },
  {
    id: 'short_desc',
    label: 'Slots with a few-word description, no protein',
    approxInputTokens: null,
    build: (r) => ({ state: recipeState(r), questions: { ...shortDescriptionQuestion() } }),
  },
  {
    id: 'labels',
    label: 'Slot names only, no protein',
    approxInputTokens: 132,
    build: (r) => ({ state: recipeState(r), questions: { ...labelsOnlyQuestion() } }),
  },
  {
    id: 'labels_5ing',
    label: 'Slot names only, no protein, first 5 ingredients',
    approxInputTokens: 114,
    build: (r) => ({ state: recipeState(r, { maxIngredients: 5 }), questions: { ...labelsOnlyQuestion() } }),
  },
  {
    id: 'labels_min',
    label: 'Slot names only, no protein, name + category only',
    approxInputTokens: 81,
    build: (r) => ({ state: { name: r.name, category: r.category || null }, questions: { ...labelsOnlyQuestion() } }),
  },
];

const VARIANT_IDS = VARIANTS.map((v) => v.id);

function variantById(id) {
  return VARIANTS.find((v) => v.id === id) || null;
}

/** { state, questions } for one recipe under one variant, or throws on an unknown id. */
function buildRequest(variantId, recipe) {
  const v = variantById(variantId);
  if (!v) throw new Error(`Unknown prompt variant "${variantId}". Known: ${VARIANT_IDS.join(', ')}`);
  return v.build(recipe);
}

module.exports = { buildProteinQuestion, recipeState, VARIANTS, VARIANT_IDS, variantById, buildRequest };
