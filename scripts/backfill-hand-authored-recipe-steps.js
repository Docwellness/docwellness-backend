/**
 * Backfills real, dish-specific cooking steps for the ~98 recipes that
 * scripts/import-hand-authored-recipes.js created with `instructions: []`
 * (the hand-authored dataset, scripts/data/hand-authored-batch-1.json, only
 * ever specified name/category/servingTime/ingredients - no cooking steps
 * were authored for it). Confirmed against the live DB that this empty-
 * instructions filter matches exactly that batch and nothing else.
 *
 * Never touches ingredients/nutrition/quantities - only calls
 * generateCookingStepsForFixedIngredients (utils/openaiClient.js), a narrow
 * AI call scoped to author steps for a FIXED ingredient list. Saves through
 * the master Recipe document (never RecipeVersion directly) and explicitly
 * awaits syncV1FromRecipe after each save, same pattern as
 * scripts/fix-viruddha-audit-recipes.js - the post-save hook is fire-and-
 * forget and can lose a race against mongoose.disconnect() on the last
 * document(s) written otherwise.
 *
 * Idempotent: re-running only processes recipes still missing instructions.
 *
 * Connects via connectDB() (config/database.js), not a raw mongoose.connect()
 * - required against prod's self-hosted Mongo, which needs the custom TLS CA
 * only connectDB() knows how to resolve (see that file's own comment on
 * migrate-dev-catalog-to-prod.js for what a raw connect() does there
 * instead: a misleading "self-signed certificate in certificate chain"
 * error). This same MONGODB_URI-driven connect works unchanged against dev.
 *
 * Usage:
 *   node scripts/backfill-hand-authored-recipe-steps.js            # dry run
 *   node scripts/backfill-hand-authored-recipe-steps.js --execute   # write
 */
require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/database');

const EXECUTE = process.argv.includes('--execute');
const DIETICIAN_EMAIL = 'tejasvini@docwellness.fit';

async function main() {
  console.log(EXECUTE ? '=== EXECUTING cooking-step backfill ===' : '=== DRY RUN (pass --execute to write) ===');
  console.log('Connecting to MongoDB...');
  await connectDB();
  console.log('Connected.');

  try {
    const { User, Recipe } = require('../models');
    const { generateCookingStepsForFixedIngredients } = require('../utils/openaiClient');
    const { syncV1FromRecipe } = require('../services/recipeVersioningService');

    const dietician = await User.findOne({ email: DIETICIAN_EMAIL, role: 'dietician' });
    if (!dietician) throw new Error(`Dietician not found: ${DIETICIAN_EMAIL}`);
    console.log(`Target dietician: ${dietician.profile?.fullName || dietician.email} (${dietician._id})\n`);

    const recipes = await Recipe.find({
      dieticianId: dietician._id,
      $or: [{ instructions: { $size: 0 } }, { instructions: { $exists: false } }],
    }).sort({ servingTime: 1, name: 1 });

    console.log(`Found ${recipes.length} recipe(s) with no cooking steps.\n`);

    let updated = 0;
    let failed = 0;

    for (const recipe of recipes) {
      if ((recipe.instructions || []).length > 0) {
        // Re-check in case a prior iteration in this same run already fixed
        // a duplicate-named doc, or a concurrent process wrote it.
        console.log(`SKIP (already has steps): "${recipe.name}"`);
        continue;
      }

      let steps;
      try {
        steps = await generateCookingStepsForFixedIngredients({
          name: recipe.name,
          servingTime: recipe.servingTime,
          ingredients: (recipe.ingredients || []).map((i) => ({
            name: i.name,
            quantity: i.quantity,
            unit: i.unit,
          })),
        });
      } catch (err) {
        console.error(`  FAILED to generate steps for "${recipe.name}": ${err.message}\n`);
        failed++;
        continue;
      }

      if (!Array.isArray(steps) || steps.length === 0) {
        console.error(`  FAILED (no steps returned) for "${recipe.name}"\n`);
        failed++;
        continue;
      }

      console.log(`"${recipe.name}" [${recipe.servingTime}]`);
      steps.forEach((s, i) => console.log(`  ${i + 1}. ${s}`));

      if (EXECUTE) {
        try {
          recipe.instructions = steps;
          await recipe.save();
          await syncV1FromRecipe(recipe);
          console.log('  saved.\n');
          updated++;
        } catch (err) {
          console.error(`  FAILED to save "${recipe.name}": ${err.message}\n`);
          failed++;
        }
      } else {
        console.log('');
      }
    }

    console.log(
      `\n=== ${EXECUTE ? 'DONE' : 'DRY RUN DONE'} === total=${recipes.length} updated=${updated} failed=${failed}`
    );
  } finally {
    await mongoose.disconnect();
    console.log('Disconnected from MongoDB.');
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
