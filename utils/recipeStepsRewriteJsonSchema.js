// Structured Outputs schema for utils/openaiClient.js's
// rewriteRecipeStepsForIngredients - deliberately tiny (one array of
// strings) compared to RECIPE_JSON_SCHEMA/EXERCISE_JSON_SCHEMA, since that
// function's only job is correcting quantity mentions inside existing step
// text, never re-authoring a recipe from scratch.

const RECIPE_STEPS_REWRITE_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['steps'],
  properties: {
    steps: {
      type: 'array',
      items: { type: 'string' },
      description:
        'The rewritten cooking steps - same count, order, and wording as the input steps, with ONLY the quantity/unit mentions corrected to match the given fixed ingredient list.',
    },
  },
};

module.exports = { RECIPE_STEPS_REWRITE_JSON_SCHEMA };
