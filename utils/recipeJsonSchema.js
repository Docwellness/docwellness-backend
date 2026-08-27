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

// Units a dish-level `components` entry may use - a superset of
// INGREDIENT_UNITS with natural whole-item/serving-vessel units so a
// component never has to be force-converted into grams to be expressed
// (e.g. "3 nos" of idli, "1 bowl" of sambar, "2 egg"). Keep in sync with
// models/Recipe.js's `components` field (no schema-level enum there - this
// JSON schema is the actual enforcement point since every recipe is
// authored via generateRecipeWithAI).
const COMPONENT_UNITS = ['g', 'ml', 'cup', 'tbsp', 'tsp', 'piece', 'nos', 'bowl', 'egg', 'slice'];

const INGREDIENT_CATEGORIES = [
  'Protein Rich', 'Carbohydrate', 'Vegetable', 'Dairy', 'Spice', 'Oil/Fat',
  'Sweetener', 'Grain', 'Legume', 'Nut/Seed', 'Fruit', 'Herb',
  'Sauce/Condiment', 'Other',
];

// recipe-core-ingredient-scaling: 'core' = the clinically/portion-meaningful
// ingredient(s) a dietician actually adjusts (a whole category group for a
// combo dish, e.g. every vegetable in Mixed Vegetable - not capped at one),
// 'sub' = everything only meaningful relative to that group (water/salt/
// oil/spices). Keep in sync with models/Recipe.js's/RecipeVersion.js's
// `role` field enum.
const INGREDIENT_ROLES = ['core', 'sub'];

// Canonical price-level convention: rupee symbols (matches the app's Indian
// cuisine context). Keep in sync with models/Recipe.js's `priceLevel` default.
const PRICE_LEVELS = ['₹', '₹₹', '₹₹₹'];

const ingredientSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'quantity', 'unit', 'category', 'priceLevel', 'description', 'isScalable', 'role'],
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
    role: {
      type: 'string',
      enum: INGREDIENT_ROLES,
      description:
        'core = this ingredient (or, for a combo/mixed dish, every ingredient sharing its category) is the clinically/portion-meaningful one a dietician actually adjusts - see the CORE INGREDIENT RULE below. sub = everything else, only meaningful relative to the core ingredient(s).',
    },
  },
};

// A single independently-adjustable component of one serving of the dish -
// e.g. {label:'Idli', quantity:3, unit:'nos'}. See models/Recipe.js's
// `components` field doc comment for the full rationale.
const componentSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['label', 'quantity', 'unit'],
  properties: {
    label: { type: 'string', description: 'This component\'s own name as a patient would recognize it, e.g. "Idli", "Sambar", "Chutney" - for a single-component dish, just repeat the dish name (e.g. "Oats Porridge").' },
    quantity: { type: 'number', minimum: 0.01 },
    unit: { type: 'string', enum: COMPONENT_UNITS },
  },
};

const RECIPE_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'name', 'description', 'category', 'cuisine', 'preparationTime', 'cookingTime',
    'ingredients', 'components', 'nutrition', 'cookingSteps', 'warnings',
  ],
  properties: {
    name: { type: 'string' },
    description: { type: 'string' },
    category: { type: 'string', enum: CATEGORIES },
    cuisine: { type: 'string', description: 'Specific cuisine type, e.g. South Indian, Tex-Mex, Cantonese, Tuscan.' },
    preparationTime: { type: 'number', description: 'Minutes.' },
    cookingTime: { type: 'number', description: 'Minutes.' },
    ingredients: { type: 'array', items: ingredientSchema },
    components: {
      type: 'array',
      items: componentSchema,
      minItems: 1,
      maxItems: 3,
      description: 'Every independently-servable/countable part of ONE serving of this dish, each in its own natural real-world unit - not force-converted to grams. A simple dish (e.g. Oats Porridge, or any single sabji/dal/curry/bhurji) has exactly one entry - NEVER decompose a dish into its individual ingredients (onion, spices, oil, garnish are not separate components). Only use more than one entry when the dish is genuinely served as several separate, independently-servable dishes on the same plate (e.g. Idli + Sambar + Chutney).',
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
  COMPONENT_UNITS,
  INGREDIENT_CATEGORIES,
  INGREDIENT_ROLES,
  PRICE_LEVELS,
  RECIPE_JSON_SCHEMA,
};
