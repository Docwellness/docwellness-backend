// Shared Structured Outputs schema for AI exercise generation, used by both
// the Responses API (`text.format`) and Chat Completions fallback
// (`response_format`) in utils/openaiClient.js. Mirrors recipeJsonSchema.js's
// role for recipes - kept in one place so the API call sites and
// models/Exercise.js's Mongoose enums can't drift out of sync.
//
// Under `strict: true`, every property must appear in `required` (no truly
// optional fields) and every object needs `additionalProperties: false`.
// videoUrl is deliberately NOT part of this schema - the model can't verify
// a real video exists at a URL it invents, unlike met/description which are
// just text it's authoring itself (see generateExercisePreview's doc comment
// in uploadExerciseController.js).

const CATEGORIES = ['Cardio', 'Strength', 'Flexibility', 'Sports', 'Other'];
const DIFFICULTY_LEVELS = ['Beginner', 'Intermediate', 'Advanced'];

const EXERCISE_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'name', 'category', 'met', 'description', 'instructions',
    'equipment', 'difficultyLevel', 'targetMuscleGroups',
  ],
  properties: {
    name: { type: 'string', description: 'The exercise name, cleaned up if needed.' },
    category: { type: 'string', enum: CATEGORIES },
    // Metabolic equivalent of task - see models/Exercise.js's own comment
    // for the caloriesBurned formula this feeds. Must be a real,
    // literature-grounded MET value for this exact exercise, not a rough
    // guess (e.g. brisk walking ~3.5, running 8km/h ~8.3, yoga ~2.5, weight
    // training moderate ~5.0, jumping rope ~11.0, swimming laps ~7.0).
    met: { type: 'number', minimum: 1, maximum: 20 },
    description: { type: 'string', description: 'Brief 1-2 sentence description of the exercise and what it targets.' },
    instructions: {
      type: 'array',
      items: { type: 'string' },
      description: 'Step-by-step cues for performing the exercise with correct form, 3-8 steps.',
    },
    equipment: {
      type: 'array',
      items: { type: 'string' },
      description: 'Equipment needed, e.g. ["Dumbbells", "Mat"] - empty array if bodyweight-only.',
    },
    difficultyLevel: { type: 'string', enum: DIFFICULTY_LEVELS },
    targetMuscleGroups: {
      type: 'array',
      items: { type: 'string' },
      description: 'Primary muscle groups worked, e.g. ["Quadriceps", "Glutes"].',
    },
  },
};

module.exports = { EXERCISE_JSON_SCHEMA, CATEGORIES, DIFFICULTY_LEVELS };
