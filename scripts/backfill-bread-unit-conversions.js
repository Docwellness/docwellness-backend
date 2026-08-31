/**
 * Follow-up to backfill-dairy-density.js. Two non-supplement recipes were
 * still unresolved on "Brown Bread": the name matches a FoodItem but bread
 * is measured in slice/piece and the FoodItem has no such unitConversion,
 * so resolveGramsForIngredient() can't turn it into grams.
 *
 * A standard sandwich slice of bread is ~30 g. Backfill
 * `unitConversions.slice` and `.piece` = 30 onto the bread FoodItems, then
 * re-sync every NON-supplement RecipeVersion still flagged unresolved.
 * (Supplement recipes are intentionally never resolved to FoodItems - they
 * carry supplementFacts instead - so they're excluded here.)
 *
 * Dry run prints each recipe's actual failing "name: qty unit" + what the
 * FoodItem currently knows, so the 30 g assumption / unit list can be
 * adjusted before writing.
 *
 * Usage:
 *   node scripts/backfill-bread-unit-conversions.js            # dry run
 *   node scripts/backfill-bread-unit-conversions.js --execute  # write
 */

require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/database');
const { syncV1FromRecipe } = require('../services/recipeVersioningService');

const EXECUTE = process.argv.includes('--execute');

const BREAD_NAMES = ['Brown Bread', 'White Bread', 'Whole Wheat Bread', 'Multigrain Bread'];
const GRAMS_PER_SLICE = 30;

async function main() {
  console.log(EXECUTE ? '=== EXECUTING ===' : '=== DRY RUN (pass --execute to write) ===\n');
  console.log('Connecting to MongoDB...');
  const tlsCAFile = connectDB.resolveTlsCAFile();
  await mongoose.connect(process.env.MONGODB_URI, tlsCAFile ? { tls: true, tlsCAFile } : {});
  console.log('Connected.\n');

  try {
    const { FoodItem, Recipe, RecipeVersion } = require('../models');

    console.log('--- 1. Bread unit conversions ---');
    let changed = 0;
    for (const name of BREAD_NAMES) {
      const fi = await FoodItem.findOne({ normalizedName: name.trim().toLowerCase() });
      if (!fi) {
        console.log(`  [missing] ${name}`);
        continue;
      }
      const uc = fi.unitConversions || {};
      console.log(`  ${name}: current unitConversions = ${JSON.stringify(uc)}, density = ${fi.density ?? 'null'}`);
      const needsSlice = typeof uc.slice !== 'number';
      const needsPiece = typeof uc.piece !== 'number';
      if (!needsSlice && !needsPiece) {
        console.log(`    [ok] already has slice/piece`);
        continue;
      }
      console.log(`    ${EXECUTE ? '✓ set' : 'would set'} slice/piece = ${GRAMS_PER_SLICE}`);
      if (EXECUTE) {
        fi.unitConversions = { ...uc, slice: GRAMS_PER_SLICE, piece: GRAMS_PER_SLICE };
        fi.markModified('unitConversions');
        await fi.save();
      }
      changed += 1;
    }
    console.log(`  ${changed} FoodItem(s) ${EXECUTE ? 'updated' : 'to update'}.`);

    console.log('\n--- 2. Re-sync non-supplement recipes still flagged unresolved ---');
    const supplementRecipeIds = new Set(
      (await Recipe.find({ category: 'Supplements' }).select('_id').lean()).map((r) => String(r._id))
    );
    const badVersions = await RecipeVersion.find({
      versionNumber: 1,
      hasUnresolvedIngredients: true,
    }).select('parentRecipeId name unresolvedIngredientNames').lean();

    const targets = badVersions.filter((v) => !supplementRecipeIds.has(String(v.parentRecipeId)));
    console.log(`  ${targets.length} non-supplement recipe(s): ${targets.map((v) => v.name).join(', ') || '(none)'}`);
    console.log(`  (${badVersions.length - targets.length} supplement recipe(s) skipped - resolved by design)`);

    let fixed = 0;
    let stillBad = 0;
    for (const v of targets) {
      const recipe = await Recipe.findById(v.parentRecipeId);
      if (!recipe) continue;
      const failing = (recipe.ingredients || [])
        .filter((i) => v.unresolvedIngredientNames.some((n) => n.toLowerCase() === (i.name || '').toLowerCase()))
        .map((i) => `${i.name}: ${i.quantity} ${i.unit}`);
      if (!EXECUTE) {
        console.log(`  "${recipe.name}" - ${failing.join(' | ') || v.unresolvedIngredientNames.join(', ')}`);
        continue;
      }
      const synced = await syncV1FromRecipe(recipe);
      if (synced && !synced.hasUnresolvedIngredients) {
        fixed += 1;
        console.log(`  ✓ resolved "${recipe.name}"`);
      } else {
        stillBad += 1;
        console.log(`  ⚠ still unresolved "${recipe.name}" - ${synced?.unresolvedIngredientNames?.join(', ')} (${failing.join(' | ')})`);
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
