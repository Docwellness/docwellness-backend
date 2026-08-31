/**
 * "slice" isn't a modelled unit anywhere - not in FoodItem.unitConversions
 * / Ingredient.unitConversions (schema keys: g/ml/cup/tbsp/tsp/piece), not
 * in recipeVersioningService's STANDARD_VOLUME_ML, not in the Flutter unit
 * picker. It only exists as an AI-generation artifact on a few recipe
 * ingredient lines (e.g. "Brown Bread: 2 slice"), which then can't be
 * converted to grams and leave the recipe's V1 flagged unresolved.
 *
 * A slice is a countable piece. Rewrite `unit: 'slice'` -> `'piece'` on
 * every recipe ingredient that has it (name + quantity unchanged, in
 * place), then re-sync each touched recipe's V1.
 *
 * Usage:
 *   node scripts/backfill-slice-to-piece.js            # dry run
 *   node scripts/backfill-slice-to-piece.js --execute  # write
 */

require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/database');
const { syncV1FromRecipe } = require('../services/recipeVersioningService');

const EXECUTE = process.argv.includes('--execute');

async function main() {
  console.log(EXECUTE ? '=== EXECUTING ===' : '=== DRY RUN (pass --execute to write) ===\n');
  console.log('Connecting to MongoDB...');
  const tlsCAFile = connectDB.resolveTlsCAFile();
  await mongoose.connect(process.env.MONGODB_URI, tlsCAFile ? { tls: true, tlsCAFile } : {});
  console.log('Connected.\n');

  try {
    const { Recipe } = require('../models');
    const recipes = await Recipe.find({ 'ingredients.unit': 'slice' }).select('name ingredients category');
    console.log(`${recipes.length} recipe(s) with a "slice" ingredient unit.\n`);

    let renamed = 0;
    const touched = [];
    for (const recipe of recipes) {
      let changed = false;
      for (const ing of recipe.ingredients) {
        if (ing.unit === 'slice') {
          console.log(`  "${recipe.name}": ${ing.name} ${ing.quantity} slice -> ${ing.quantity} piece`);
          if (EXECUTE) ing.unit = 'piece';
          renamed += 1;
          changed = true;
        }
      }
      if (changed) {
        touched.push(recipe);
        if (EXECUTE) {
          recipe.markModified('ingredients');
          await recipe.save();
        }
      }
    }
    console.log(`\n  ${touched.length} recipe(s), ${renamed} ingredient line(s) ${EXECUTE ? 'changed' : 'to change'}.`);

    if (EXECUTE) {
      console.log('\n--- V1 re-sync ---');
      let ok = 0;
      let bad = 0;
      for (const t of touched) {
        const fresh = await Recipe.findById(t._id);
        const synced = await syncV1FromRecipe(fresh);
        if (synced && !synced.hasUnresolvedIngredients) {
          ok += 1;
          console.log(`  ✓ "${t.name}"`);
        } else {
          bad += 1;
          console.log(`  ⚠ "${t.name}" still unresolved - ${synced?.unresolvedIngredientNames?.join(', ')}`);
        }
      }
      console.log(`\n  Resolved: ${ok}, still unresolved: ${bad}`);
    }

    console.log(EXECUTE ? '\n=== DONE ===' : '\n=== DRY RUN complete ===');
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error('Failed:', err);
  process.exit(1);
});
