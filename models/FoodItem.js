const mongoose = require('mongoose');
const { ALLERGY_CATEGORY_KEYWORDS } = require('../utils/dietaryConstraintValidator');

// The v4.0 ingredient-versioning engine's canonical nutrition source -
// global/dietician-independent (unlike Ingredient.js, which is deliberately
// per-dietician), because "100g of Toor Dal = X kcal" is a real-world fact,
// not something that should vary by which dietician's account created it.
// RecipeVersion.ingredients[].foodItemId is the only thing that references
// this collection - Recipe.ingredients[] (the legacy, days-array-system
// display path) is untouched and never gets a FoodItem reference backfilled
// onto its history, per the v4.0 plan's Phase 0b decision.
const foodItemSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    // trim+lowercase form of `name`, same convention as
    // Ingredient.normalizedName - used for case-insensitive lookup when
    // services/recipeVersioningService.js resolves a Recipe.ingredients[]
    // name to a FoodItem.
    normalizedName: {
      type: String,
      required: true,
    },
    nutritionPer100g: {
      calories: { type: Number, default: null },
      protein: { type: Number, default: null },
      carbs: { type: Number, default: null },
      fats: { type: Number, default: null },
      fiber: { type: Number, default: null },
    },
    // g/ml, for volume<->weight conversion where unitConversions below
    // doesn't already give a direct answer for the needed unit.
    density: { type: Number, default: null },
    // Trim/peel/cooking loss, 0-100 - not applied by any nutrition
    // calculation yet (services/recipeVersioningService.js computes
    // nutritionPerServing from raw, as-entered rawQuantity), reserved for a
    // future raw-to-edible-weight adjustment.
    wastePercentage: { type: Number, default: 0, min: 0, max: 100 },
    // Grams-per-1-unit reference weight, keyed the same way
    // Ingredient.unitConversions is - lets rawQuantity be entered in
    // whatever unit is natural (tsp, piece, cup) while nutrition math still
    // needs a gram-equivalent under the hood.
    unitConversions: {
      g: { type: Number },
      ml: { type: Number },
      cup: { type: Number },
      tbsp: { type: Number },
      tsp: { type: Number },
      piece: { type: Number },
    },
    clinical: {
      glycemicIndex: { type: Number, default: null },
      allergens: {
        type: [String],
        enum: Object.keys(ALLERGY_CATEGORY_KEYWORDS),
        default: [],
      },
      tags: { type: [String], default: [] },
    },
    // Where nutritionPer100g came from - lets
    // scripts/reportFoodItemNutritionCoverage.js and the dietician-facing
    // "needs nutrition data" badge distinguish a real, sourced figure from
    // one nobody has entered yet, without treating a missing value
    // ambiguously (see also RecipeVersion.hasUnresolvedIngredients, which is
    // the actual enforcement point).
    dataSource: {
      type: String,
      enum: ['tier1-seed', 'dietician-entered', 'unresolved'],
      default: 'unresolved',
    },
    // Admin-traceability only ("this FoodItem was seeded from Ingredient X")
    // - never read by any nutrition-math code path. Ingredient.js stays
    // per-dietician and untouched; this is purely a breadcrumb.
    sourceIngredientId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Ingredient',
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

foodItemSchema.index({ normalizedName: 1 }, { unique: true });

module.exports = mongoose.model('FoodItem', foodItemSchema);
