// Shared Structured Outputs schema for AI diet-plan generation, mirroring
// utils/recipeJsonSchema.js's approach for recipes. Kept in one place so the
// Responses API (`text.format`) and Chat Completions fallback
// (`response_format`) call sites in utils/openaiClient.js can't drift apart,
// and so it stays in sync with the weeks[].dailyMeals[] shape that
// controllers/dietician/dietPlanController.js's getDietPlanDetails parses.
//
// Under `strict: true`, every property must appear in `required` (no truly
// optional fields) and every object needs `additionalProperties: false`.

const { DAY_GROUPS } = require('./dayGroups');

const REQUIRED_SERVING_TIMES = [
  'Morning Drink',
  'Breakfast',
  'Brunch',
  'Lunch',
  'Evening Snack',
  'Dinner',
  'Night Drink',
];

const dailyMealSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['dayGroup', 'servingTime', 'recipeId'],
  properties: {
    // Monday repeats on Friday, Tuesday on Saturday, Wednesday on Sunday,
    // Thursday is unique - see buildPrompt's day-structure rules. Never
    // generate separate Friday/Saturday/Sunday entries.
    dayGroup: { type: 'string', enum: DAY_GROUPS },
    servingTime: { type: 'string', enum: REQUIRED_SERVING_TIMES },
    recipeId: {
      type: 'string',
      description:
        'Must be exactly one of the "id" values from the recipe list for THIS SAME entry\'s servingTime (see the per-slot recipe lists in the prompt) - never an id from a different slot\'s list, never invented.',
    },
  },
};

const weekSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['week', 'dailyMeals'],
  properties: {
    week: { type: 'number', enum: [1, 2, 3, 4] },
    dailyMeals: {
      type: 'array',
      items: dailyMealSchema,
    },
  },
};

const DIET_PLAN_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['weeks'],
  properties: {
    weeks: {
      type: 'array',
      items: weekSchema,
    },
  },
};

module.exports = {
  REQUIRED_SERVING_TIMES,
  DIET_PLAN_JSON_SCHEMA,
};
