const mongoose = require('mongoose');

// v4.0's standalone-collection equivalent of one entry in the old
// DietPlan.days[].meals[].items[] embedded array - but pointing at a
// RecipeVersion instead of a Recipe+servingMultiplier. There is deliberately
// no servingMultiplier/scaling field here at all: a PlanItem's portion is
// whatever its recipeVersionId's ingredients[].rawQuantity say it is -
// changing the portion means creating a new RecipeVersion (see
// services/recipeVersioningService.js::createCustomVersion) and repointing
// recipeVersionId, not mutating a scalar on this document.
const planItemSchema = new mongoose.Schema(
  {
    mealSlotId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'MealSlotPlan',
      required: true,
    },
    recipeVersionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'RecipeVersion',
      required: true,
    },
    // Skipped by services/ingredientAutoBalanceService.js - the dietician
    // has manually pinned this item's portion, same semantics as the old
    // days[].items[].locked.
    locked: {
      type: Boolean,
      default: false,
    },
    // Also skipped by services/ingredientAutoBalanceService.js's auto-balance,
    // but a WEAKER state than `locked`: set true whenever a dietician saves
    // a hand-edited portion (ingredient quantities or "Makes on the plate")
    // via the ingredient editor, so a later "Auto Adjust" solves the day's
    // calorie gap with the OTHER recipes instead of silently re-scaling this
    // deliberate choice. Unlike `locked`, a pinned item can still be swapped
    // or removed. Cleared from the Refine Portions card's "Edited" badge.
    // See openspec change diet-wizard-portions-and-polish
    // (diet-plan-wizard/refine-portions-pinning).
    pinned: {
      type: Boolean,
      default: false,
    },
    // Cached from recipeVersionId's nutritionPerServing at assignment time
    // so reads never re-join RecipeVersion just to show calories/macros -
    // same "cache so reads never re-join" convention as the old model's
    // days[].items[].calculatedNutrition.
    calculatedNutrition: {
      calories: { type: Number, default: null },
      protein: { type: Number, default: null },
      carbs: { type: Number, default: null },
      fats: { type: Number, default: null },
      fiber: { type: Number, default: null },
    },
    isLinkedComponent: { type: Boolean, default: false },
    // A linked side/salad is chosen once per slot type (a Recipe, not a
    // specific RecipeVersion) - unlike recipeVersionId above, this doesn't
    // need version-level precision.
    parentRecipeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Recipe',
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

planItemSchema.index({ mealSlotId: 1 });

module.exports = mongoose.model('PlanItem', planItemSchema);
