/**
 * Backfills the new `components` array (see models/Recipe.js's doc comment)
 * on every existing recipe from its old servingSize/secondaryComponent
 * fields - a mechanical, no-AI-call migration: servingSize becomes
 * components[0], secondaryComponent (if present) becomes components[1].
 * This does NOT give old recipes realistic per-item units (a recipe stored
 * as servingSize {quantity:2, unit:'g'} stays 2g, not "2 egg") - it only
 * makes every recipe's data shape consistent so `components`-aware code can
 * read every recipe uniformly. Getting old recipes onto real units requires
 * re-running them through generateRecipeWithAI (now components-aware) or a
 * manual dietician edit - a separate, deliberately-not-automatic follow-up,
 * since silently AI-rewriting a dietician's already-reviewed recipe data
 * needs their own review pass, not a blind background job.
 *
 * Idempotent - only touches recipes with no `components` yet, so re-running
 * after new recipes are added (which already write `components` themselves
 * via the updated generateRecipeWithAI) is a no-op for those.
 *
 * Usage:
 *   node scripts/migrate-recipe-components.js            # dry run
 *   node scripts/migrate-recipe-components.js --execute   # actually write
 */

require('dotenv').config();
const mongoose = require('mongoose');

const EXECUTE = process.argv.includes('--execute');

async function main() {
  console.log(EXECUTE ? '=== EXECUTING components backfill ===' : '=== DRY RUN (pass --execute to write) ===');

  console.log('Connecting to MongoDB...');
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected.');

  try {
    const { Recipe } = require('../models');

    const recipes = await Recipe.find({
      $or: [{ components: { $exists: false } }, { components: { $size: 0 } }],
    })
      .select('name servingSize secondaryComponent')
      .lean();

    console.log(`Found ${recipes.length} recipe(s) with no components yet.`);

    let planned = 0;
    let skippedNoServingSize = 0;
    const bulkOps = [];

    for (const recipe of recipes) {
      const quantity = recipe.servingSize?.quantity;
      const unit = recipe.servingSize?.unit;
      if (!(quantity > 0) || !unit) {
        skippedNoServingSize++;
        console.log(`  [skip: no usable servingSize] "${recipe.name}" (${recipe._id})`);
        continue;
      }

      const components = [{ label: recipe.name || 'Serving', quantity, unit }];
      if (recipe.secondaryComponent?.quantity > 0 && recipe.secondaryComponent?.unit) {
        components.push({
          label: recipe.secondaryComponent.label || 'Add-on',
          quantity: recipe.secondaryComponent.quantity,
          unit: recipe.secondaryComponent.unit,
        });
      }

      planned++;
      bulkOps.push({
        updateOne: {
          filter: { _id: recipe._id },
          update: { $set: { components } },
        },
      });
    }

    console.log(
      `\n=== PLAN: ${planned} recipe(s) to backfill, ${skippedNoServingSize} skipped (no usable servingSize - needs manual review) ===`
    );

    if (!EXECUTE) {
      console.log('\nThis was a dry run - no DB writes. Re-run with --execute to write these.');
      return;
    }

    if (bulkOps.length === 0) {
      console.log('\nNothing to write.');
      return;
    }

    const result = await Recipe.bulkWrite(bulkOps);
    console.log(`\n=== DONE: modified ${result.modifiedCount} recipe(s) ===`);
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
