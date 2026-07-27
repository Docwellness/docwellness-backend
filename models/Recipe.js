const mongoose = require('mongoose');

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
    ingredients: [
      {
        name: { type: String, required: true },
        quantity: { type: Number, required: true },
        unit: {
          type: String,
          enum: ['g', 'ml', 'cup', 'tbsp', 'tsp', 'piece'],
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
  },
  {
    timestamps: true,
  }
);

// Had no indexes at all before this - dieticianId scoping is present on
// every query (multi-tenant: a dietician only ever sees their own
// recipes), combined with servingTime (AI-generation recipe pool
// building, dietPlanOptions.js) or category (browsing/filtering,
// uploadRecipieController.js's listRecipes).
recipeSchema.index({ dieticianId: 1, servingTime: 1 });
recipeSchema.index({ dieticianId: 1, category: 1 });

module.exports = mongoose.model('Recipe', recipeSchema);
