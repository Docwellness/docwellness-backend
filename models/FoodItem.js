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
      // Added by fill-recipe-micronutrients (openspec) - g unless noted.
      // null means "not researched", never "zero" - see
      // micronutrientProvenance below for what backs a real 0.
      saturatedFat: { type: Number, default: null },
      transFat: { type: Number, default: null },
      sugar: { type: Number, default: null },
      cholesterol: { type: Number, default: null }, // mg
      sodium: { type: Number, default: null }, // mg
      calcium: { type: Number, default: null }, // mg
      iron: { type: Number, default: null }, // mg
      potassium: { type: Number, default: null }, // mg
      vitaminC: { type: Number, default: null }, // mg
    },
    // Per-nutrient sourcing record for the nine fields above - keyed by
    // nutrient name (e.g. "iron"). Exists so a real, multi-source-confirmed
    // 0 (status: 'verified-zero') stays distinguishable from a value nobody
    // has looked up yet (status: 'unknown', which is what every ingredient
    // starts at) - see openspec/changes/fill-recipe-micronutrients/design.md
    // Decision 2 and Decision 5's zero-is-a-finding rule.
    micronutrientProvenance: {
      type: Map,
      of: new mongoose.Schema(
        {
          status: { type: String, enum: ['researched', 'verified-zero', 'unknown'], default: 'unknown' },
          sources: [
            {
              name: String, // e.g. 'IFCT2017', 'USDA-FDC'
              ref: String, // food code / FDC id / URL
              value: { type: Number, default: null },
              basis: { type: String, enum: ['raw', 'as-eaten'], default: 'raw' },
            },
          ],
          confidence: { type: String, enum: ['high', 'medium', 'low'], default: 'low' },
          // Not an enum: 'multi-source' | 'single-source' | 'rule:<name>' (e.g.
          // 'rule:plant-cholesterol') - the rule name is open-ended per design.md
          // Decision 5, so a fixed enum can't express it.
          method: { type: String, default: 'single-source', validate: {
            validator: (v) => v === 'multi-source' || v === 'single-source' || /^rule:/.test(v),
            message: 'method must be multi-source, single-source, or rule:<name>',
          } },
          note: String,
          researchedAt: Date,
        },
        { _id: false }
      ),
      default: undefined,
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
