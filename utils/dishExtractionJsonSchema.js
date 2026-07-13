// Structured Outputs schema for the "retrieval" stage of bulk recipe import
// (scripts/import-recipes-from-diet-plans.js): given the raw text of one
// source diet-plan document (English/Marathi/Hindi mix, several different
// formatting styles), identify every distinct dish and pull out exactly the
// source text that belongs to it - grounding the next stage's recipe
// generation in the right chunk per dish, rather than re-deriving structure
// with brittle per-format regex. Mirrors utils/recipeJsonSchema.js's
// `strict: true` conventions.

const { REQUIRED_SERVING_TIMES } = require('./dietPlanJsonSchema');

const dishSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'dishName', 'servingTime', 'isVegetarian', 'isEgg', 'isNonVegetarian',
    'hasStructuredIngredients', 'rawIngredientsText', 'rawRecipeText',
  ],
  properties: {
    dishName: {
      type: 'string',
      description: 'English name of the dish - translate/transliterate from Marathi/Hindi if needed, but keep recognizable Indian dish names as-is (e.g. "Bhakri", "Chilla", "Usal").',
    },
    servingTime: { type: 'string', enum: REQUIRED_SERVING_TIMES },
    isVegetarian: { type: 'boolean' },
    isEgg: { type: 'boolean', description: 'True if this specific dish itself contains egg.' },
    isNonVegetarian: { type: 'boolean', description: 'True if this specific dish contains meat/chicken/fish.' },
    hasStructuredIngredients: {
      type: 'boolean',
      description: 'True if the source gives a real ingredient list for this dish (with at least some quantities). False if the dish is only named (e.g. in a weekly schedule table cell) with no ingredient detail at all.',
    },
    rawIngredientsText: {
      type: ['string', 'null'],
      description: 'The exact ingredient list text as it appears in the source, verbatim, original language and quantities preserved. Null if hasStructuredIngredients is false.',
    },
    rawRecipeText: {
      type: ['string', 'null'],
      description: 'The exact cooking-steps text as it appears in the source, verbatim, original language. Null if no cooking steps are given.',
    },
  },
};

const DISH_EXTRACTION_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['dishes'],
  properties: {
    dishes: { type: 'array', items: dishSchema },
  },
};

module.exports = { DISH_EXTRACTION_JSON_SCHEMA };
