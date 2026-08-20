const mongoose = require('mongoose');

// v4.0's standalone-collection equivalent of one entry in the old
// DietPlan.days[].meals[].supplements[] embedded array. Supplements
// deliberately stay plain Recipe references (category:'Supplements', see
// dietPlanOptions.js's SUPPLEMENTS_PSEUDO_SLOT) rather than being versioned
// like food items - a fixed-dose tablet/capsule has no ingredient-level
// portioning need, unlike a cooked dish.
const supplementItemSchema = new mongoose.Schema(
  {
    mealSlotId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'MealSlotPlan',
      required: true,
    },
    supplementRecipeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Recipe',
      required: true,
    },
    dosage: { type: String, default: null },
    instructions: { type: String, default: null },
    timingAnchor: {
      type: String,
      enum: ['pre', 'with', 'post'],
      default: 'with',
    },
    locked: { type: Boolean, default: true },
    // Supplements already don't count toward nutrition.calories today (they
    // carry Recipe.supplementFacts instead) - this just makes that existing
    // behavior explicit/queryable, same as the old model's
    // days[].meals[].supplements[].excludeFromCalories.
    excludeFromCalories: { type: Boolean, default: true },
  },
  {
    timestamps: true,
  }
);

supplementItemSchema.index({ mealSlotId: 1 });

module.exports = mongoose.model('SupplementItem', supplementItemSchema);
