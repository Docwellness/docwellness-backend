const mongoose = require('mongoose');
const { inferAllergenCategoriesFromIngredientNames, ALLERGY_CATEGORY_KEYWORDS } = require('../utils/dietaryConstraintValidator');
const { deriveComponentsFromIngredients, componentsAreDerivable } = require('../utils/coreIngredientHeuristic');

const recipeSchema = new mongoose.Schema(
  {
    dieticianId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    name: {
      type: String,
      required: [true, 'Recipe name is required'],
      trim: true,
    },
    category: {
      type: String,
      enum: [
        'Indian',
        'American',
        'British',
        'Mediterranean',
        'Asian',
        'Mexican',
        'Italian',
        'French',
        'Middle Eastern',
        'Japanese',
        'Chinese',
        'Thai',
        'Korean',
        'Continental',
        'Fusion',
        'Healthy Bowls',
        'Smoothies & Drinks',
        'Supplements',
        'Keto',
        'Vegan Specials',
        'High Protein',
        'Low Carb',
        'Detox',
        'Other',
        'Western',
      ],
      default: 'Indian',
    },
    cuisine: {
      type: String,
      trim: true,
    },
    // Cross-cutting role tags, independent of `category` - e.g. a Jowar
    // Bhakri stays category:'Indian' + servingTime:'Lunch' (so it still
    // shows under the Indian/Lunch browsing) while ALSO being tagged
    // 'side' so it surfaces in the dedicated Sides shortcut section.
    // Extend this enum additively for future cross-cutting sections, same
    // convention as `category`.
    tags: {
      type: [String],
      enum: ['side', 'salad'],
      default: [],
    },
    servings: {
      type: Number,
      default: 1,
    },
    servingTime: {
      type: String,
      enum: [
        'Morning Drink',
        'Breakfast',
        'Brunch',
        'Lunch',
        'Evening Snack',
        'Dinner',
        'Night Drink',
      ],
      required: true,
    },

    preparationTime: {
      type: Number, // in minutes
    },
    cookingTime: {
      type: Number, // in minutes
    },
    // Legacy single-primary-quantity representation - superseded by
    // `components` below, kept (and still populated, derived from
    // components[0]) purely for backward read-compatibility with consumers
    // not yet migrated (dietPlanOptions.js, dietPlanValidator.js,
    // weekNutritionSummary.js, the dietician app). Do not add new writers
    // of this field beyond that derivation - author new data via
    // `components` instead.
    servingSize: {
      quantity: { type: Number, default: null },
      unit: { type: String, default: null },
    },
    // Legacy second-quantity representation (see servingSize comment) -
    // superseded by components[1]. Still derived/populated for the same
    // backward-compatibility reason.
    secondaryComponent: {
      type: {
        label: { type: String },
        quantity: { type: Number },
        unit: { type: String },
      },
      default: undefined,
    },
    // Real-world, independently-adjustable components of a single serving -
    // e.g. Idli with Sambar and Chutney is [{label:'Idli',quantity:3,
    // unit:'nos'}, {label:'Sambar',quantity:1,unit:'bowl'},
    // {label:'Chutney',quantity:2,unit:'tbsp'}], and a plain Oats Porridge
    // is just [{label:'Oats Porridge',quantity:250,unit:'g'}]. Replaces the
    // old fixed primary+secondary shape above (which forced every dish
    // into exactly 1-2 components, and the primary one into grams/ml only)
    // with an arbitrary-length list so a dietician-facing quantity always
    // matches how the dish is actually prescribed/eaten. See
    // utils/recipeJsonSchema.js's COMPONENT_UNITS for the allowed unit set.
    components: {
      type: [
        {
          label: { type: String, required: true },
          quantity: { type: Number, required: true },
          unit: { type: String, required: true },
        },
      ],
      default: undefined,
    },
    // Explicit override, default false: forces the pre-save hook below to
    // always leave `components` exactly as authored, skipping even its own
    // auto-detection. Normally NOT needed - the hook already only derives
    // `components` from `ingredients.filter(role === 'core')` when every
    // existing component label matches an ingredient name (see
    // utils/coreIngredientHeuristic.js's componentsAreDerivable); most
    // recipes (a composite, multi-dish one - Idli+Sambar+Chutney, or
    // "Pithla Bhakri" -> components "Pithla"/"Bhakri", neither a raw
    // ingredient - or even a simple single-ingredient dish named
    // differently from its ingredient, e.g. "Oats Porridge" made from
    // "Oats") already fail that check on their own and are left alone
    // automatically. This flag exists for the rare case a dietician/script
    // needs to force manual authorship despite an incidental full name
    // match. See openspec/changes/unify-recipe-ingredients-and-components/
    // design.md's Decisions.
    componentsAuthoredManually: { type: Boolean, default: false },
    ingredients: [
      {
        name: { type: String, required: true },
        quantity: { type: Number, required: true },
        // Matches utils/recipeJsonSchema.js's COMPONENT_UNITS exactly - an
        // ingredient's unit is synced from its matching component (see
        // scripts/sync-recipe-ingredients-with-components.js and
        // dietController.js's buildGroceryItemsForWeek), so it needs to
        // accept every unit a component can have, not a narrower set. Was
        // previously missing 'nos'/'bowl'/'egg'/'slice', which made that
        // sync fail outright for any ingredient whose matching component
        // used one of them.
        unit: {
          type: String,
          enum: ['g', 'ml', 'cup', 'tbsp', 'tsp', 'piece', 'nos', 'bowl', 'egg', 'slice'],
          default: 'g',
        },
        category: {
          type: String,
          enum: [
            'Protein Rich',
            'Carbohydrate',
            'Vegetable',
            'Dairy',
            'Spice',
            'Oil/Fat',
            'Sweetener',
            'Grain',
            'Legume',
            'Nut/Seed',
            'Fruit',
            'Herb',
            'Sauce/Condiment',
            'Other',
          ],
          default: 'Other',
        },
        priceLevel: {
          type: String,
          enum: ['$', '$$', '$$$', '₹', '₹₹', '₹₹₹', '£', '££', '£££'],
          default: '₹₹',
        },
        description: { type: String, default: '' },
        image: String,
        isScalable: { type: Boolean, default: true },
        // v4.0: optional link to the global FoodItem nutrition record for
        // this ingredient. NOT backfilled onto existing recipes' history -
        // this array stays the legacy, days-array-system display path
        // throughout coexistence (see models/Ingredient.js's own comment on
        // why this array's order/shape is never touched). Only ever
        // populated as a side effect of services/recipeVersioningService.js
        // resolving names to FoodItems when generating this recipe's V1
        // RecipeVersion - never read by any days-array-system code.
        foodItemId: { type: mongoose.Schema.Types.ObjectId, ref: 'FoodItem', default: null },
        // recipe-core-ingredient-scaling: which ingredient(s) are the
        // clinically/portion-meaningful ones a dietician actually adjusts
        // ('core' - e.g. Chapati's Whole Wheat Flour, or every vegetable in
        // a Mixed Vegetable dish together) vs. ones only meaningful
        // relative to that group ('sub' - water/salt/oil/spices). A recipe
        // should have at least one 'core' ingredient, no upper bound - this
        // is an application-level invariant (enforced by createRecipe/
        // updateRecipe/generateRecipeWithAI's output validation, same
        // convention as dietaryHabits/freeFrom conflict checks in
        // utils/dietaryConstraintValidator.js), not a schema-level
        // constraint, so existing recipes with every ingredient defaulted
        // to 'sub' remain valid documents (see recipe-ingredient-scaling
        // capability for the resulting "not yet migrated" fallback
        // behavior in services/recipeVersioningService.js's
        // createCustomVersion). Never conflate with isScalable above - that
        // is a different, pre-existing concept (serving-multiplier
        // participation at read time, see utils/dietPlanReadDispatch.js).
        role: { type: String, enum: ['core', 'sub'], default: 'sub' },
      },
    ],
    instructions: [
      {
        type: String,
      },
    ],
    dietaryHabits: {
      vegan: { type: Boolean, default: false },
      jain: { type: Boolean, default: false },
      vegetarian: { type: Boolean, default: false },
      nonVegetarian: { type: Boolean, default: false },
      eggitarian: { type: Boolean, default: false },
    },
    freeFrom: {
      sugar: { type: Boolean, default: false },
      salt: { type: Boolean, default: false },
      processedFood: { type: Boolean, default: false },
      oil: { type: Boolean, default: false },
    },
    image: {
      type: String,
    },
    language: {
      type: [String],
      enum: ['Hindi', 'English', 'Marathi'],
      default: ['English'],
    },
    // Translations for multilingual support
    // Keys are language names, values contain translated content
    translations: {
      type: Map,
      of: {
        name: { type: String },
        description: { type: String },
        ingredients: [
          {
            name: { type: String },
            description: { type: String },
          },
        ],
        // Positionally aligned with the top-level `components` array (the
        // PORTIONS SUMMARY chips) - only `label` needs translating,
        // quantity/unit stay as-authored. See utils/openaiClient.js's
        // generateTranslations.
        components: [
          {
            label: { type: String },
          },
        ],
        cookingSteps: [{ type: String }],
        warnings: [{ type: String }],
      },
      default: {},
    },
    nutrition: {
      calories: { type: Number },
      protein: { type: Number }, // grams
      carbs: { type: Number }, // grams
      fats: { type: Number }, // grams
      fiber: { type: Number, default: 0 }, // grams
    },
    // Real per-serving active-ingredient facts for category:'Supplements'
    // recipes - a vitamin/mineral tablet's meaningful numbers are its
    // ingredient amounts and %NRV, not calories/protein/carbs/fats, so
    // supplements carry this instead of relying on `nutrition` (which stays
    // zeroed for them - see scripts/update-supplement-nutrition-facts.js).
    supplementFacts: {
      type: {
        brand: { type: String },
        servingSize: {
          quantity: { type: Number },
          unit: { type: String },
          label: { type: String },
        },
        servingsPerContainer: { type: Number },
        nutrients: [
          {
            name: { type: String, required: true },
            amount: { type: Number, required: true },
            unit: { type: String, required: true },
            percentNRV: { type: Number, default: null },
          },
        ],
      },
      default: undefined,
    },
    // --- Deterministic diet-plan engine fields (all additive/optional -
    // existing docs stay valid with none of these set; nothing reads them
    // until the engine, services/recipeSelectionEngine.js, ships) ---
    // The yield `nutrition`/`components` are calibrated to - distinct from
    // `servings` (a display count) since a recipe's authored nutrition may
    // already be scoped to a different base amount (e.g. "per 250g bowl"
    // vs "per 1 serving = 2 idlis").
    baseYield: {
      quantity: { type: Number, default: null },
      unit: { type: String, default: null },
    },
    cookingMethod: {
      type: String,
      enum: ['raw', 'boiled', 'steamed', 'fried', 'baked', 'roasted'],
      default: 'raw',
    },
    // Cooked-weight/raw-weight ratio (e.g. raw rice 1.0 -> cooked 3.0) -
    // reserved for a future raw-ingredient-based nutrition recompute, not
    // applied to `nutrition`/`nutritionPerServing` by anything yet.
    moistureChangeFactor: { type: Number, default: 1 },
    // Per-servingTime suitability weight (0-1+) the engine's scoring uses
    // alongside calorie/macro fit - e.g. {'Breakfast':1.0,'Brunch':0.6}.
    // Empty by default; scripts/migrate-diet-plan-typed-schema.js's
    // sibling backfill step derives an initial value from `servingTime`
    // + `tags` so the engine has real signal without every recipe being
    // manually re-tagged first.
    mealSlotSuitability: { type: Map, of: Number, default: {} },
    // Free-form reusable labels beyond the fixed dietaryHabits/freeFrom
    // booleans (e.g. 'low-fodmap', 'high-potassium').
    dietaryTags: { type: [String], default: [] },
    // Auto-aggregated from `ingredients[].name` in the pre-save hook below
    // (same category keys as Ingredient.clinical.allergens) - a cache for
    // the engine to filter on without re-scanning ingredient names on every
    // generation run. Never authored directly.
    allergens: {
      type: [String],
      enum: Object.keys(ALLERGY_CATEGORY_KEYWORDS),
      default: [],
    },
    version: { type: Number, default: 1 },
    parentRecipeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Recipe', default: null },
    status: { type: String, enum: ['Active', 'Archived'], default: 'Active' },
    // Cache of `nutrition`, refreshed in the pre-save hook below - exists so
    // engine code can read a field explicitly scoped "per serving" without
    // assuming that's what the legacy `nutrition` field means (it is today,
    // but isn't named that way).
    nutritionPerServing: {
      calories: { type: Number, default: null },
      protein: { type: Number, default: null },
      carbs: { type: Number, default: null },
      fats: { type: Number, default: null },
      fiber: { type: Number, default: null },
    },
  },
  {
    timestamps: true,
  }
);

// Best-effort, non-blocking: keeps `allergens`/`nutritionPerServing`/
// `components`/`servingSize`/`secondaryComponent` in sync with
// `ingredients`/`nutrition` whenever either changes, so callers never have
// to remember to recompute them by hand. Never throws - a recipe save must
// never fail because of this bookkeeping.
recipeSchema.pre('save', function () {
  try {
    if (this.isNew || this.isModified('ingredients')) {
      const names = (this.ingredients || []).map((ingredient) => ingredient?.name);
      this.allergens = inferAllergenCategoriesFromIngredientNames(names);
    }
    if (
      this.isNew ||
      this.isModified('ingredients') ||
      this.isModified('components') ||
      this.isModified('componentsAuthoredManually')
    ) {
      // `components` (the portion-summary chips) is server-derived from
      // `ingredients[].role` ONLY when that's actually safe: every
      // currently-set component label already matches an ingredient name
      // (componentsAreDerivable), and the recipe isn't explicitly forced
      // manual. Most recipes fail that check on their own and are left
      // exactly as authored - a composite, multi-dish recipe (Idli+Sambar+
      // Chutney) whose components name prepared sub-dishes, or even an
      // ordinary single-ingredient dish named differently from its
      // ingredient ("Oats Porridge" made from "Oats") - matching today's
      // existing behavior for both. This intentionally does NOT try to
      // guess/backfill a partially-matching recipe (e.g. 1 of 4 components
      // present in `ingredients`) - that's genuinely ambiguous between "a
      // data-entry gap" and "a composite dish with one coincidental name
      // match," and gets surfaced by scripts/audit-recipe-components-
      // drift.js for a human to resolve instead. See openspec/changes/
      // unify-recipe-ingredients-and-components/design.md's Decisions.
      if (
        !this.componentsAuthoredManually &&
        componentsAreDerivable(this.components, this.ingredients)
      ) {
        const derivedComponents = deriveComponentsFromIngredients(this.ingredients);
        if (derivedComponents.length > 0) {
          this.components = derivedComponents;
        } else if (!this.components || this.components.length === 0) {
          this.components = undefined;
        }
        // else: derivation found zero `role: 'core'` ingredients (e.g. an
        // existing recipe whose ingredients haven't been migrated to carry
        // `role` yet - see scripts/unify-recipe-components-into-
        // ingredients.js) while `components` already held a real value -
        // leave it untouched rather than silently wiping a previously
        // -correct portion summary down to empty.
      }
      // `servingSize`/`secondaryComponent` (legacy single/dual-quantity
      // mirrors, see their own field comments above) always mirror
      // `components[0]`/`[1]`, whichever way `components` itself got set.
      const mirrorSource = this.components || [];
      this.servingSize = mirrorSource[0]
        ? { quantity: mirrorSource[0].quantity, unit: mirrorSource[0].unit }
        : { quantity: null, unit: null };
      this.secondaryComponent = mirrorSource[1]
        ? {
          label: mirrorSource[1].label,
          quantity: mirrorSource[1].quantity,
          unit: mirrorSource[1].unit,
        }
        : undefined;
    }
    if (this.isNew || this.isModified('nutrition')) {
      this.nutritionPerServing = {
        calories: this.nutrition?.calories ?? null,
        protein: this.nutrition?.protein ?? null,
        carbs: this.nutrition?.carbs ?? null,
        fats: this.nutrition?.fats ?? null,
        fiber: this.nutrition?.fiber ?? null,
      };
    }
  } catch (err) {
    console.error('Recipe pre-save allergen/nutrition cache failed (non-blocking):', err.message);
  }
});

// v4.0: keeps this recipe's V1 RecipeVersion (services/recipeVersioningService.js)
// up to date on every save. Fire-and-forget (post-save, not pre-save, and
// never awaited) - a recipe save must never be slowed down or fail because
// of this bookkeeping, and syncV1FromRecipe itself never throws (see its own
// try/catch) and is cheap/idempotent to re-run even when nothing
// ingredient-relevant actually changed (deliberately not gated on
// isModified() here - Mongoose's modified-path tracking is unreliable to
// rely on this late in the post-save hook chain). Lazy-required to avoid a
// module-load-time dependency between this model and the service layer,
// matching services/dietPlanGenerationService.js's existing lazy-require
// convention for the same reason.
recipeSchema.post('save', function (doc) {
  const { syncV1FromRecipe } = require('../services/recipeVersioningService');
  syncV1FromRecipe(doc).catch((err) => {
    console.error(`Recipe post-save V1 RecipeVersion sync failed (non-blocking) for ${doc._id}:`, err.message);
  });
});

// Had no indexes at all before this - dieticianId scoping is present on
// every query (multi-tenant: a dietician only ever sees their own
// recipes), combined with servingTime (AI-generation recipe pool
// building, dietPlanOptions.js) or category (browsing/filtering,
// uploadRecipieController.js's listRecipes).
recipeSchema.index({ dieticianId: 1, servingTime: 1 });
recipeSchema.index({ dieticianId: 1, category: 1 });

module.exports = mongoose.model('Recipe', recipeSchema);
