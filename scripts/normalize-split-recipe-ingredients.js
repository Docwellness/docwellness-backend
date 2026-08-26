/**
 * Follow-up to scripts/split-main-and-side-recipes.js: that run's fresh AI
 * regeneration picked ingredient names/spellings (American English -
 * "Cilantro", "Green Chili", "Baking Soda") that don't match this
 * catalog's existing FoodItem entries (Indian-English convention -
 * "Coriander Leaves", "Green Chilli"), plus a couple of genuinely new
 * ingredients (Celery, Mayonnaise, Butter, ...) with no FoodItem at all -
 * so RecipeVersion.hasUnresolvedIngredients came back true for 24 of the
 * 30 split mains, undercounting their nutrition (computed from only the
 * resolved subset - see recipeVersioningService.js's own "never fabricate"
 * comment).
 *
 * Three fixes, in order:
 *   1. RENAME_MAP - an ingredient name that's a pure synonym of an already-
 *      complete FoodItem (e.g. "Cilantro" -> "Coriander Leaves") gets its
 *      Recipe.ingredients[].name string rewritten to the canonical
 *      spelling. Zero new data, zero nutrition-figure risk.
 *   2. GHEE_UNIT_FIX - the existing "Ghee" FoodItem's unitConversions had
 *      no `tbsp` entry (only g/tsp), so every regenerated dal recipe using
 *      "1 tbsp Ghee" stayed unresolved despite Ghee's own nutritionPer100g
 *      being complete. Adds tbsp/cup conversions.
 *   3. NEW_FOOD_ITEMS - ingredients with no existing FoodItem under any
 *      spelling (Coconut Oil, Celery, Mayonnaise, Vegetable Broth, Baking
 *      Soda, Butter, Dijon Mustard) get a real one, hand-compiled from
 *      standard IFCT/USDA-style reference figures - same dataSource:
 *      'tier1-seed' convention as scripts/foodItemNutritionData.js.
 *
 * After all three, re-runs syncV1FromRecipe on every one of the 30 split
 * mains (cheap/idempotent - a rename with nothing left to fix is a no-op)
 * and reports the final resolved/unresolved tally.
 *
 * Always safe to re-run - every step is upsert/check-then-write.
 *
 * Usage: node scripts/normalize-split-recipe-ingredients.js
 */
require('dotenv').config();
const connectDB = require('../config/database');
const { syncV1FromRecipe } = require('../services/recipeVersioningService');

const MAIN_IDS = [
  '6a8de40c727c939296a81df4','6a8de40c727c939296a81e00','6a8de40e727c939296a81e4e','6a8de40f727c939296a81eb3',
  '6a8de410727c939296a81edb','6a8de410727c939296a81ee1','6a8de40e727c939296a81e54','6a8de40c727c939296a81dfa',
  '6a8de410727c939296a81eb9','6a8de40d727c939296a81e12','6a8de40e727c939296a81e5a','6a8de40c727c939296a81dee',
  '6a8de40c727c939296a81e0c','6a8de40d727c939296a81e18','6a8de40d727c939296a81e24','6a8de40d727c939296a81e48',
  '6a8de40f727c939296a81ea8','6a8de410727c939296a81ed0','6a8da11b0ebafe80ec36cd44','6a8da1770ebafe80ec36cdc2',
  '6a8de40d727c939296a81e1e','6a8de40a727c939296a81d74','6a8de40b727c939296a81da0','6a8de40f727c939296a81eae',
  '6a50ec49d286aeeaeb756724','6a50ee8cd286aeeaeb756970','6a8da0160ebafe80ec36cc60','6a8de40a727c939296a81d67',
  '6a8de40a727c939296a81d7f','6a8de40a727c939296a81d9b',
];

// key: lowercased name as it appears in a Recipe's own ingredients[] ->
// exact existing-FoodItem canonical name to rewrite it to.
const RENAME_MAP = {
  'cilantro': 'Coriander Leaves',
  'green chili': 'Green Chilli',
  'green chilli': 'Green Chilli',
  'red chili powder': 'Red Chilli Powder',
  'green bell pepper': 'Bell Pepper',
  'capsicum': 'Bell Pepper',
  'baby eggplant': 'Brinjal',
  'fish (preferably kingfish or seer fish)': 'Fish',
  'kala chana (black chickpeas)': 'Kala Chana',
  'split yellow moong dal': 'Moong Dal',
  'red lentils (masoor dal)': 'Masoor Dal',
  'red curry paste': 'Thai Red Curry Paste',
  'green onion': 'Spring Onion',
  'vegetable oil': 'Oil',
  'ridge gourd (turai)': 'Ridge Gourd',
  'shiitake mushrooms': 'Mushroom',
};

// Real IFCT/USDA-style per-100g reference figures, same convention/caveat
// as scripts/foodItemNutritionData.js's own header comment - approximate,
// good enough for diet-plan-level guidance, not a clinical lab reference.
// unitConversions only include the specific unit(s) these 30 recipes
// actually use for that ingredient (checked against the live data before
// writing this), not a speculative full set.
const NEW_FOOD_ITEMS = [
  {
    name: 'Coconut Oil',
    nutritionPer100g: { calories: 862, protein: 0, carbs: 0, fats: 100, fiber: 0 },
    unitConversions: { g: 1, tsp: 4.5, tbsp: 13.6, cup: 218 },
  },
  {
    name: 'Celery',
    nutritionPer100g: { calories: 16, protein: 0.7, carbs: 3.0, fats: 0.2, fiber: 1.6 },
    unitConversions: { g: 1 },
  },
  {
    name: 'Mayonnaise',
    nutritionPer100g: { calories: 680, protein: 1.1, carbs: 1.6, fats: 75, fiber: 0 },
    unitConversions: { g: 1, tsp: 4.6, tbsp: 13.8 },
  },
  {
    name: 'Vegetable Broth',
    nutritionPer100g: { calories: 5, protein: 0.3, carbs: 1.0, fats: 0.1, fiber: 0 },
    unitConversions: { g: 1 },
    density: 1.0,
  },
  {
    name: 'Baking Soda',
    nutritionPer100g: { calories: 0, protein: 0, carbs: 0, fats: 0, fiber: 0 },
    unitConversions: { g: 1, tsp: 4.6, tbsp: 13.8 },
  },
  {
    name: 'Butter',
    nutritionPer100g: { calories: 717, protein: 0.9, carbs: 0.1, fats: 81, fiber: 0 },
    unitConversions: { g: 1, tsp: 4.7, tbsp: 14.2, cup: 227 },
  },
  {
    name: 'Dijon Mustard',
    nutritionPer100g: { calories: 66, protein: 4.4, carbs: 5.3, fats: 4.0, fiber: 3.3 },
    unitConversions: { g: 1, tsp: 5, tbsp: 15 },
  },
];

async function fixGheeUnitConversions() {
  const { FoodItem } = require('../models');
  const ghee = await FoodItem.findOne({ normalizedName: 'ghee' });
  if (!ghee) { console.log('  ✗ "Ghee" FoodItem not found - skipping'); return; }
  const before = { ...ghee.unitConversions };
  ghee.unitConversions = { ...ghee.unitConversions, tbsp: 13.5, cup: 218 };
  await ghee.save();
  console.log(`  ✓ Ghee.unitConversions: ${JSON.stringify(before)} -> ${JSON.stringify(ghee.unitConversions)}`);
}

async function createMissingFoodItems() {
  const { FoodItem } = require('../models');
  for (const item of NEW_FOOD_ITEMS) {
    const normalizedName = item.name.trim().toLowerCase();
    const existing = await FoodItem.findOne({ normalizedName });
    if (existing) { console.log(`  [skip: already exists] "${item.name}"`); continue; }
    await FoodItem.create({
      name: item.name,
      normalizedName,
      nutritionPer100g: item.nutritionPer100g,
      unitConversions: item.unitConversions,
      density: item.density ?? null,
      dataSource: 'tier1-seed',
    });
    console.log(`  ✓ Created FoodItem "${item.name}"`);
  }
}

async function applyRenames() {
  const { Recipe } = require('../models');
  let recipesChanged = 0;
  let ingredientsRenamed = 0;
  for (const id of MAIN_IDS) {
    const recipe = await Recipe.findById(id);
    if (!recipe) continue;
    let changed = false;
    for (const ing of recipe.ingredients) {
      const canonical = RENAME_MAP[ing.name.trim().toLowerCase()];
      if (canonical && ing.name !== canonical) {
        console.log(`  "${recipe.name}": "${ing.name}" -> "${canonical}"`);
        ing.name = canonical;
        changed = true;
        ingredientsRenamed++;
      }
    }
    if (changed) {
      recipe.markModified('ingredients');
      await recipe.save();
      recipesChanged++;
    }
  }
  console.log(`  ${recipesChanged} recipe(s) changed, ${ingredientsRenamed} ingredient name(s) renamed`);
}

async function resyncAndReport() {
  const { Recipe, RecipeVersion } = require('../models');
  let resolved = 0;
  let stillUnresolved = 0;
  for (const id of MAIN_IDS) {
    const recipe = await Recipe.findById(id);
    if (!recipe) continue;
    const version = await syncV1FromRecipe(recipe);
    if (!version) { console.log(`  ✗ sync failed for "${recipe.name}"`); continue; }
    if (version.hasUnresolvedIngredients) {
      stillUnresolved++;
      console.log(`  ⚠ still unresolved: "${recipe.name}" - ${version.unresolvedIngredientNames.join(', ')}`);
    } else {
      resolved++;
    }
  }
  console.log(`\n  Fully resolved: ${resolved}/${MAIN_IDS.length}, still unresolved: ${stillUnresolved}/${MAIN_IDS.length}`);
}

async function main() {
  await connectDB();
  try {
    console.log('=== Step 1: fix Ghee unitConversions ===');
    await fixGheeUnitConversions();

    console.log('\n=== Step 2: create missing FoodItems ===');
    await createMissingFoodItems();

    console.log('\n=== Step 3: rename synonym ingredient names across the 30 split mains ===');
    await applyRenames();

    console.log('\n=== Step 4: re-sync RecipeVersions and report ===');
    await resyncAndReport();
  } finally {
    await require('mongoose').disconnect();
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
