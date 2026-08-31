/**
 * One-off cleanup for the 8 recipe ingredient names still unresolved after
 * backfill-recipe-versions.js (see suggest-foodItem-matches.js output,
 * 2026-08-31): 5 recipes - Varan, Cucumber Raita, Curd, Sambar,
 * Coconut Chutney.
 *
 * Two parts:
 *   1. Create 3 missing FoodItems (Asafoetida, Sambar Powder, Low-Fat Milk)
 *      with per-100g nutrition + unit conversions. Skipped if they already
 *      exist.
 *   2. Rename the drifted ingredient names on every recipe that uses them
 *      IN PLACE at the same array index (never reorder/insert/remove - the
 *      Flutter apps match translations[lang].ingredients[] to ingredients[]
 *      by index; see migrate-canonical-ingredients.js's constraint).
 *
 * `.save()` on each changed recipe fires Recipe.js's post-save hook, which
 * re-syncs the V1 RecipeVersion. This script also calls syncV1FromRecipe
 * explicitly on every touched recipe afterward and reports the result.
 *
 * Idempotent: a second run finds the FoodItems already present and no
 * names left to rename.
 *
 * Usage:
 *   node scripts/resolve-remaining-recipe-ingredients.js            # dry run
 *   node scripts/resolve-remaining-recipe-ingredients.js --execute  # write
 */

require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/database');
const { syncV1FromRecipe } = require('../services/recipeVersioningService');

const EXECUTE = process.argv.includes('--execute');

// name -> per-100g nutrition + gram-per-unit conversions.
const NEW_FOOD_ITEMS = [
  {
    name: 'Asafoetida',
    // Compounded hing as sold in India is mostly flour + gum with a little
    // oleo-gum-resin. Always used in pinches (~0.1-0.3 g) so the exact
    // figure barely moves any recipe's total - this just lets it resolve.
    nutritionPer100g: { calories: 297, protein: 4, carbs: 68, fats: 1, fiber: 4 },
    unitConversions: { g: 1, tsp: 3, tbsp: 9 },
  },
  {
    name: 'Sambar Powder',
    // Roasted-lentil + spice blend (chana/toor dal, coriander, red chilli,
    // cumin, fenugreek, black pepper, curry leaf).
    nutritionPer100g: { calories: 330, protein: 14, carbs: 50, fats: 9, fiber: 20 },
    unitConversions: { g: 1, tsp: 4, tbsp: 12 },
  },
  {
    name: 'Low-Fat Milk',
    // ~1.5% fat cow's milk.
    nutritionPer100g: { calories: 42, protein: 3.4, carbs: 5, fats: 1, fiber: 0 },
    unitConversions: { ml: 1, cup: 240, tbsp: 15, tsp: 5 },
  },
];

// normalized (trim+lowercase) recipe ingredient name -> canonical name to
// write. Every target is an existing or just-created FoodItem name.
const RENAME_MAP = {
  turmeric: 'Turmeric Powder',
  'green chili': 'Green Chilli',
  'roasted chana dal': 'Roasted Chana',
  'low-fat yogurt': 'Low-Fat Curd',
  'low-fat milk': 'Low-Fat Milk',
  'curd culture': 'Curd',
  'hing (asafoetida)': 'Asafoetida',
  // "Sambar Powder" needs no rename - the new FoodItem's name matches it.
};

async function createMissingFoodItems() {
  const { FoodItem } = require('../models');
  let created = 0;
  for (const item of NEW_FOOD_ITEMS) {
    const normalizedName = item.name.trim().toLowerCase();
    const existing = await FoodItem.findOne({ normalizedName });
    if (existing) {
      console.log(`  [exists] ${item.name}`);
      continue;
    }
    if (EXECUTE) {
      await FoodItem.create({
        name: item.name,
        normalizedName,
        nutritionPer100g: item.nutritionPer100g,
        unitConversions: item.unitConversions,
        dataSource: 'tier1-seed',
      });
    }
    created += 1;
    console.log(`  ${EXECUTE ? '✓ created' : 'would create'}  ${item.name}`);
  }
  console.log(`  ${created} FoodItem(s) ${EXECUTE ? 'created' : 'to create'}.`);
}

async function applyRenames() {
  const { Recipe } = require('../models');
  const recipes = await Recipe.find({
    'ingredients.name': { $exists: true },
  }).select('name ingredients');

  const touched = [];
  let renamed = 0;
  for (const recipe of recipes) {
    let changed = false;
    recipe.ingredients.forEach((ing) => {
      const target = RENAME_MAP[(ing.name || '').trim().toLowerCase()];
      if (target && ing.name !== target) {
        console.log(`  "${recipe.name}": "${ing.name}" -> "${target}"`);
        if (EXECUTE) ing.name = target;
        renamed += 1;
        changed = true;
      }
    });
    if (changed) {
      touched.push(recipe);
      if (EXECUTE) {
        recipe.markModified('ingredients');
        await recipe.save();
      }
    }
  }
  console.log(`  ${touched.length} recipe(s), ${renamed} ingredient name(s) ${EXECUTE ? 'renamed' : 'to rename'}.`);
  return touched;
}

async function resyncAndReport(touched) {
  const { Recipe } = require('../models');
  if (!EXECUTE) {
    console.log('  (dry run - skipping V1 re-sync)');
    return;
  }
  let ok = 0;
  let bad = 0;
  for (const t of touched) {
    const fresh = await Recipe.findById(t._id);
    const version = await syncV1FromRecipe(fresh);
    if (!version) {
      console.log(`  ✗ sync failed: "${t.name}"`);
      continue;
    }
    if (version.hasUnresolvedIngredients) {
      bad += 1;
      console.log(`  ⚠ still unresolved: "${t.name}" - ${version.unresolvedIngredientNames.join(', ')}`);
    } else {
      ok += 1;
    }
  }
  console.log(`  Fully resolved: ${ok}, still unresolved: ${bad}`);
}

async function main() {
  console.log(EXECUTE ? '=== EXECUTING ===' : '=== DRY RUN (pass --execute to write) ===\n');
  console.log('Connecting to MongoDB...');
  const tlsCAFile = connectDB.resolveTlsCAFile();
  const connectOptions = tlsCAFile ? { tls: true, tlsCAFile } : {};
  await mongoose.connect(process.env.MONGODB_URI, connectOptions);
  console.log('Connected.\n');

  try {
    console.log('--- 1. Missing FoodItems ---');
    await createMissingFoodItems();
    console.log('\n--- 2. Ingredient renames ---');
    const touched = await applyRenames();
    console.log('\n--- 3. V1 RecipeVersion re-sync ---');
    await resyncAndReport(touched);
    console.log(
      EXECUTE
        ? '\n=== DONE. Re-run backfill-recipe-versions.js to confirm 0 unresolved. ==='
        : '\n=== DRY RUN complete - re-run with --execute to apply. ==='
    );
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error('Failed:', err);
  process.exit(1);
});
