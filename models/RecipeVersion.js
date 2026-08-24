const mongoose = require('mongoose');
const { COMPONENT_UNITS } = require('../utils/recipeJsonSchema');
const { ALLERGY_CATEGORY_KEYWORDS } = require('../utils/dietaryConstraintValidator');

// v4.0's core new entity, replacing servingMultiplier-based scaling with
// ingredient-level portioning + versioning. A RecipeVersion is an immutable
// snapshot of "this exact recipe, with these exact ingredient quantities" -
// V1 is auto-generated from a Recipe whenever it's saved (see the post-save
// hook on models/Recipe.js and services/recipeVersioningService.js's
// syncV1FromRecipe), V2+ are created only by
// recipeVersioningService.createCustomVersion (a dietician editing ingredient
// quantities for one specific patient's plan).
//
// Immutability is a CODE-level discipline, not a schema-level lock: no
// service ever calls .save() on an existing RecipeVersion to change its
// ingredients/nutritionPerServing after creation - createCustomVersion always
// inserts a brand-new document. This is what makes "editing an ingredient
// does not mutate V1" true (see tests/recipeVersioningService.test.js).
//
// Once any PlanItem references a specific RecipeVersion._id, syncV1FromRecipe
// must never again silently update that same document in place - it must
// bump to a new versionNumber instead, so a later edit to the master Recipe
// can never silently change food already prescribed to a patient. This is
// the load-bearing invariant this whole model exists to protect (the
// equivalent, one level up, of the problem services/smartSyncService.js
// solves for the old days-array model).
const recipeVersionSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    parentRecipeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Recipe',
      required: true,
    },
    versionNumber: {
      type: Number,
      required: true,
      min: 1,
      default: 1,
    },
    baseYield: {
      quantity: { type: Number, default: null },
      unit: { type: String, default: null },
    },
    cookingMethod: {
      type: String,
      enum: ['raw', 'boiled', 'steamed', 'fried', 'baked', 'roasted'],
      default: 'raw',
    },
    // Cooked-weight/raw-weight ratio - copied from the parent Recipe at
    // creation time, not applied to nutritionPerServing by anything yet
    // (same "reserved for future use" status it has on Recipe.js).
    moistureChangeFactor: { type: Number, default: 1 },
    // The actual ingredient-level portions this version prescribes - the
    // whole point of v4.0. rawQuantity is an exact, dietician-set amount
    // (grams/ml/etc, NOT a bounded scaling ratio), matching the same
    // "real prescribed quantity, no min/max" philosophy
    // DietPlan.days[].items[].servingMultiplier used in the old model.
    ingredients: [
      {
        foodItemId: { type: mongoose.Schema.Types.ObjectId, ref: 'FoodItem', required: true },
        rawQuantity: { type: Number, required: true, min: 0 },
        unit: { type: String, enum: COMPONENT_UNITS, required: true },
        preparation: { type: String, default: null },
      },
    ],
    steps: { type: [String], default: [] },
    // Real-world serving-unit measurement of the WHOLE dish (e.g. "Palak
    // Paratha" -> [{label:'Palak Paratha', quantity:2, unit:'piece'}],
    // "Khichdi" -> [{quantity:1, unit:'bowl'}]) - distinct from
    // ingredients[] above (the raw food items IN the dish, e.g. wheat
    // flour/spinach/oil in grams). Copied from the parent Recipe's own
    // `components` at V1 creation (services/recipeVersioningService.js's
    // syncV1FromRecipe) and proportionally rescaled by createCustomVersion
    // whenever ingredients are edited/auto-balanced, so "2 pieces" becomes
    // "3 pieces" if the dietician doubles the recipe rather than staying
    // stuck at the V1 figure. This is what the wizard's Step 3 list and
    // patient-facing views render instead of a bare gram/calorie figure.
    // No unit enum here (mirrors Recipe.components' own lack of one) -
    // historical recipes can carry a component unit outside COMPONENT_UNITS,
    // and syncV1FromRecipe copying one through must never fail validation.
    components: {
      type: [
        {
          label: { type: String, required: true },
          quantity: { type: Number, required: true },
          unit: { type: String, required: true },
        },
      ],
      default: [],
    },
    // Computed by services/recipeVersioningService.js from
    // ingredients[].rawQuantity * FoodItem.nutritionPer100g/100, summed - the
    // "real per-ingredient macros" this whole model exists to provide,
    // distinct from Recipe.nutritionPerServing (which is just a cached copy
    // of the dietician's hand-authored, whole-recipe nutrition figure).
    nutritionPerServing: {
      calories: { type: Number, default: null },
      protein: { type: Number, default: null },
      carbs: { type: Number, default: null },
      fats: { type: Number, default: null },
      fiber: { type: Number, default: null },
    },
    // True if any ingredient's foodItemId resolves to a FoodItem with
    // nutritionPer100g still null (or couldn't be resolved to a FoodItem at
    // all) - nutritionPerServing above is computed from only the resolved
    // ingredients in that case, never silently treated as 0 or approximated.
    // services/menuGenerationService.js refuses to select a V1 with this set,
    // so incomplete ingredient data is a visible generation-time gate, not a
    // silent inaccuracy - see the v4.0 plan's Phase 0c.
    hasUnresolvedIngredients: { type: Boolean, default: false },
    unresolvedIngredientNames: { type: [String], default: [] },
    // Per-servingTime suitability weight, same shape/semantics as
    // Recipe.mealSlotSuitability - copied from the parent Recipe at V1
    // creation, but independently editable on later versions since a V2 with
    // materially different ingredients (e.g. added protein powder) may
    // legitimately suit a different slot than V1 did.
    mealSlotSuitability: { type: Map, of: Number, default: {} },
    dietaryTags: { type: [String], default: [] },
    allergens: {
      type: [String],
      enum: Object.keys(ALLERGY_CATEGORY_KEYWORDS),
      default: [],
    },
    status: {
      type: String,
      enum: ['Active', 'Archived'],
      default: 'Active',
    },
    // The dietician who created THIS specific version - null for an
    // auto-generated V1 (the post-save hook runs with no dietician "in the
    // room" at that moment, it's just mirroring the Recipe).
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

// The core lookup this whole model is built around: "give me V1 of Recipe X"
// (services/menuGenerationService.js) and "what's the next version number for
// Recipe X" (services/recipeVersioningService.js::createCustomVersion).
recipeVersionSchema.index({ parentRecipeId: 1, versionNumber: 1 }, { unique: true });
recipeVersionSchema.index({ parentRecipeId: 1, status: 1 });

module.exports = mongoose.model('RecipeVersion', recipeVersionSchema);
