// Shared Structured Outputs schema for AI recipe generation, used by both the
// Responses API (`text.format`) and Chat Completions fallback (`response_format`)
// in utils/openaiClient.js. Kept in one place so the two API call sites and
// models/Recipe.js's Mongoose enums can't drift out of sync the way the old
// prose-only schema already had (see priceLevel mismatch fixed alongside this).
//
// Under `strict: true`, every property must appear in `required` (no truly
// optional fields) and every object needs `additionalProperties: false`.

const CATEGORIES = [
  'Indian', 'American', 'British', 'Mediterranean', 'Asian', 'Mexican',
  'Italian', 'French', 'Middle Eastern', 'Japanese', 'Chinese', 'Thai',
  'Korean', 'Continental', 'Fusion', 'Healthy Bowls', 'Smoothies & Drinks',
  'Supplements', 'Keto', 'Vegan Specials', 'High Protein', 'Low Carb',
  'Detox', 'Other', 'Western',
];

const INGREDIENT_UNITS = ['g', 'ml', 'cup', 'tbsp', 'tsp', 'piece'];

const INGREDIENT_CATEGORIES = [
  'Protein Rich', 'Carbohydrate', 'Vegetable', 'Dairy', 'Spice', 'Oil/Fat',
  'Sweetener', 'Grain', 'Legume', 'Nut/Seed', 'Fruit', 'Herb',
  'Sauce/Condiment', 'Other',
];

// Canonical price-level convention: rupee symbols (matches the app's Indian
// cuisine context). Keep in sync with models/Recipe.js's `priceLevel` default.
const PRICE_LEVELS = ['₹', '₹₹', '₹₹₹'];

const ingredientSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'quantity', 'unit', 'category', 'priceLevel', 'description', 'isScalable'],
  properties: {
    name: { type: 'string', description: 'The RAW GROCERY ITEM a person would buy at a store, e.g. "Lemon" not "Lemon Juice".' },
    // Never 0 or a placeholder - see the NO ZERO/PLACEHOLDER QUANTITIES RULE
    // in openaiClient.js's prompt. Schema-level backstop in case the prompt
    // instruction alone doesn't hold; utils/ingredientQuantityValidator.js's
    // enforceFiniteIngredientQuantities is the deterministic final backstop.
    quantity: { type: 'number', minimum: 0.01 },
    unit: { type: 'string', enum: INGREDIENT_UNITS },
    category: { type: 'string', enum: INGREDIENT_CATEGORIES },
    priceLevel: { type: 'string', enum: PRICE_LEVELS },
    description: { type: 'string', description: 'Brief nutritional benefit or cooking note.' },
    isScalable: { type: 'boolean' },
  },
};

const RECIPE_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'name', 'description', 'category', 'cuisine', 'preparationTime', 'cookingTime',
    'ingredients', 'servingSize', 'nutrition', 'cookingSteps', 'warnings',
  ],
  properties: {
    name: { type: 'string' },
    description: { type: 'string' },
    category: { type: 'string', enum: CATEGORIES },
    cuisine: { type: 'string', description: 'Specific cuisine type, e.g. South Indian, Tex-Mex, Cantonese, Tuscan.' },
    preparationTime: { type: 'number', description: 'Minutes.' },
    cookingTime: { type: 'number', description: 'Minutes.' },
    ingredients: { type: 'array', items: ingredientSchema },
    servingSize: {
      type: 'object',
      additionalProperties: false,
      required: ['quantity', 'unit', 'servings'],
      properties: {
        quantity: { type: 'number' },
        unit: { type: 'string', enum: ['g', 'ml'] },
        servings: { type: 'number' },
      },
    },
    nutrition: {
      type: 'object',
      additionalProperties: false,
      required: ['calories', 'protein', 'carbs', 'fats', 'fiber'],
      properties: {
        calories: { type: 'number', description: 'Per serving.' },
        protein: { type: 'number', description: 'Grams per serving.' },
        carbs: { type: 'number', description: 'Grams per serving.' },
        fats: { type: 'number', description: 'Grams per serving.' },
        fiber: { type: 'number', description: 'Grams per serving.' },
      },
    },
    cookingSteps: { type: 'array', items: { type: 'string' } },
    warnings: { type: 'array', items: { type: 'string' }, description: 'Dietary warnings or allergen info; empty array if none.' },
  },
};

module.exports = {
  CATEGORIES,
  INGREDIENT_UNITS,
  INGREDIENT_CATEGORIES,
  PRICE_LEVELS,
  RECIPE_JSON_SCHEMA,
};
