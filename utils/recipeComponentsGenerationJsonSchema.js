// Structured Outputs schema for utils/openaiClient.js's
// generateComponentsForFixedIngredients - deliberately scoped to just
// "components" (like recipeStepsRewriteJsonSchema.js's steps-only schema),
// since that function's only job is authoring a realistic "Makes (on the
// plate)" portion breakdown for a dish whose ingredients are already fixed,
// never re-authoring the recipe itself.

const { COMPONENT_UNITS } = require('./recipeJsonSchema');

const RECIPE_COMPONENTS_GENERATION_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['components'],
  properties: {
    components: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['label', 'quantity', 'unit'],
        properties: {
          label: { type: 'string' },
          quantity: { type: 'number', minimum: 0.01 },
          unit: { type: 'string', enum: COMPONENT_UNITS },
        },
      },
      description:
        'One serving of the dish, broken into its real, separately-servable/countable parts (typically 1-3) - see the prompt\'s COMPONENTS RULE for the full guidance.',
    },
  },
};

module.exports = { RECIPE_COMPONENTS_GENERATION_JSON_SCHEMA };
