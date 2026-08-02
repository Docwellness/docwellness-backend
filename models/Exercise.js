const mongoose = require('mongoose');

// Catalog of exercises a dietician can assign to a patient's ExercisePlan -
// mirrors Recipe.js's role as the dietician's own content library, scoped
// per-dietician the same way (dieticianId + category is the dominant query
// shape there too - see Recipe.js's index).
const exerciseSchema = new mongoose.Schema(
  {
    dieticianId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    name: {
      type: String,
      required: [true, 'Exercise name is required'],
      trim: true,
    },
    category: {
      type: String,
      enum: ['Cardio', 'Strength', 'Flexibility', 'Sports', 'Other'],
      default: 'Other',
    },
    // Metabolic equivalent of task - the standard exercise-science unit
    // (e.g. brisk walking ~3.5, running ~9.8, yoga ~2.5, weight training
    // ~5.0). caloriesBurned = met * weightKg * durationHours (see
    // utils/exerciseHelpers.js's calcCaloriesBurned) - this scales with the
    // individual patient's actual weight, unlike a flat calories/minute
    // figure.
    met: {
      type: Number,
      required: [true, 'MET value is required'],
      min: 1,
      max: 20,
    },
    // Short blurb + step-by-step cues, mirrors Recipe.js's description/
    // instructions split - description is the catalog-tile summary,
    // instructions are the how-to-perform steps.
    description: {
      type: String,
      default: '',
    },
    instructions: {
      type: [String],
      default: [],
    },
    // A demo/tutorial link the dietician pastes in (e.g. YouTube) - not
    // AI-generated (see uploadExerciseController.js's generateExercisePreview
    // doc comment for why: an AI can't verify a real video exists at a URL,
    // unlike met/description which are just text it's authoring itself).
    videoUrl: {
      type: String,
      default: '',
    },
    equipment: {
      type: [String],
      default: [],
    },
    difficultyLevel: {
      type: String,
      enum: ['Beginner', 'Intermediate', 'Advanced'],
      default: 'Beginner',
    },
    targetMuscleGroups: {
      type: [String],
      default: [],
    },
    image: {
      type: String,
      default: '',
    },
    tags: {
      type: [String],
      default: [],
    },
    // Mirrors Recipe.js's language/translations split - name/description/
    // instructions get AI-translated at creation time (see
    // generateExerciseTranslations in utils/openaiClient.js), so a patient
    // viewing in their preferred language (see RecipeLanguageService, shared
    // app-wide rather than exercise-specific) sees exercise content in it
    // too, not just recipes.
    language: {
      type: [String],
      default: ['English'],
    },
    translations: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  {
    timestamps: true,
  }
);

exerciseSchema.index({ dieticianId: 1, category: 1 });

module.exports = mongoose.model('Exercise', exerciseSchema);
