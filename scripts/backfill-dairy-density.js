/**
 * Follow-up to resolve-remaining-recipe-ingredients.js. After that ran,
 * one recipe ("Curd") was still unresolved: its starter "Curd" ingredient
 * is measured in a spoon/volume unit, but the "Curd" FoodItem has no
 * `density` and no volume `unitConversions`, so
 * recipeVersioningService.resolveGramsForIngredient() can't turn that
 * volume into grams.
 *
 * Cheapest general fix: give the dairy FoodItems a `density` (~1.03 g/ml),
 * which makes ALL volume units (ml/tsp/tbsp/cup) resolve via the
 * density path, for every recipe that measures them by spoon - not just
 * this one.
 *
 * Usage:
 *   node scripts/backfill-dairy-density.js            # dry run
 *   node scripts/backfill-dairy-density.js --execute  # write
 */

require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/database');
const { syncV1FromRecipe } = require('../services/recipeVersioningService');

const EXECUTE = process.argv.includes('--execute');

// Liquid/semi-liquid dairy, ~1.03 g/ml. Only touched if `density` is unset.
const DAIRY_NAMES = ['Curd', 'Low-Fat Curd', 'Yogurt', 'Milk'];
const DAIRY_DENSITY = 1.03;

async function main() {
  console.log(EXECUTE ? '=== EXECUTING ===' : '=== DRY RUN (pass --execute to write) ===\n');
  console.log('Connecting to MongoDB...');
  const tlsCAFile = connectDB.resolveTlsCAFile();
  await mongoose.connect(process.env.MONGODB_URI, tlsCAFile ? { tls: true, tlsCAFile } : {});
  console.log('Connected.\n');

  try {
    const { FoodItem, Recipe, RecipeVersion } = require('../models');

    console.log('--- 1. Dairy density ---');
    let densitySet = 0;
    for (const name of DAIRY_NAMES) {
      const fi = await FoodItem.findOne({ normalizedName: name.trim().toLowerCase() });
      if (!fi) {
        console.log(`  [missing] ${name} - no FoodItem`);
        continue;
      }
      if (typeof fi.density === 'number' && fi.density > 0) {
        console.log(`  [ok] ${name} - density already ${fi.density}`);
        continue;
      }
      console.log(`  ${EXECUTE ? '✓ set' : 'would set'} ${name}.density = ${DAIRY_DENSITY}`);
      if (EXECUTE) {
        fi.density = DAIRY_DENSITY;
        await fi.save();
      }
      densitySet += 1;
    }
    console.log(`  ${densitySet} FoodItem(s) ${EXECUTE ? 'updated' : 'to update'}.`);

    console.log('\n--- 2. Re-sync recipes that still have unresolved V1 ingredients ---');
    const badVersions = await RecipeVersion.find({
      versionNumber: 1,
      hasUnresolvedIngredients: true,
    }).select('parentRecipeId name unresolvedIngredientNames').lean();
    console.log(`  ${badVersions.length} recipe(s) currently flagged unresolved: ${badVersions.map((v) => v.name).join(', ') || '(none)'}`);

    let fixed = 0;
    let stillBad = 0;
    for (const v of badVersions) {
      const recipe = await Recipe.findById(v.parentRecipeId);
      if (!recipe) continue;
      if (!EXECUTE) {
        const lines = (recipe.ingredients || [])
          .filter((i) => v.unresolvedIngredientNames.some((n) => n.toLowerCase() === (i.name || '').toLowerCase()))
          .map((i) => `${i.name}: ${i.quantity} ${i.unit}`);
        console.log(`  would re-sync "${recipe.name}" - unresolved: ${lines.join(' | ') || v.unresolvedIngredientNames.join(', ')}`);
        continue;
      }
      const synced = await syncV1FromRecipe(recipe);
      if (synced && !synced.hasUnresolvedIngredients) {
        fixed += 1;
        console.log(`  ✓ resolved "${recipe.name}"`);
      } else {
        stillBad += 1;
        console.log(`  ⚠ still unresolved "${recipe.name}" - ${synced?.unresolvedIngredientNames?.join(', ')}`);
      }
    }
    if (EXECUTE) console.log(`\n  Resolved: ${fixed}, still unresolved: ${stillBad}`);

    console.log(EXECUTE ? '\n=== DONE ===' : '\n=== DRY RUN complete ===');
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error('Failed:', err);
  process.exit(1);
});
