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
    servingSize: {
      quantity: { type: Number, default: null },
      unit: { type: String, default: null },
    },
    // For a handful of compound snacks (e.g. "Banana with Roasted Chana and
    // Seeds") that combine a countable fruit with a scoopable mix-in -
    // servingSize represents the primary component (the fruit, in pieces),
    // this represents the second one (e.g. seeds/chikki, in tbsp/grams) -
    // the dietician app renders a second independent +/- stepper for it
    // when present. Absent (undefined) for every ordinary single-quantity
    // recipe.
    secondaryComponent: {
      type: {
        label: { type: String },
        quantity: { type: Number },
        unit: { type: String },
      },
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
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model('Recipe', recipeSchema);
