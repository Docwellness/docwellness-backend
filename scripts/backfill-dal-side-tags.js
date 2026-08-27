/**
 * Root-cause fix for "Varan keeps showing up for lunch AND dinner, every
 * day-group" (reported against a generated diet plan): only 2 of the
 * catalog's dozen-plus dal/legume-curry dishes were ever tagged
 * `tags:['side']` - Varan and Sambar. Every other dal (Rajma, Chole, Dal
 * Tadka, Masoor Dal, Whole Masoor Dal, Chana Dal, Dal Palak, Palak Dal,
 * Methi Dal, Light Dal Makhani) was left as an untagged, own-slot-only
 * recipe, so it can only ever be picked as a Lunch/Dinner MAIN dish, never
 * as the "dal" component of a sabji+bread+rice+dal+salad combo (see
 * utils/dietPlanOptions.js's SIDE_SALAD_ELIGIBLE_SLOTS broadening and
 * utils/openaiClient.js's buildPrompt combo rule, both of which only ever
 * see 'side'-tagged recipes as accompaniment candidates). With only Varan
 * and Sambar eligible for that role, near-daily Varan repetition isn't a
 * generation-quality bug so much as the pool genuinely only having 2 real
 * choices - this backfill fixes the DATA gap that causes it, not just the
 * symptom.
 *
 * Deliberately excludes one-pot complete-meal dishes that share a "dal"
 * word in their name (Moong Dal Khichdi) - per the prompt's own combo rule,
 * a khichdi/biryani/pulav/idli/dosa/uttapa is already a complete meal and
 * must NEVER get a bread/rice/dal/salad side added alongside it, so tagging
 * it 'side' would be actively wrong, not just unhelpful. Also leaves
 * usal-type dishes (Veg Usal, Matki Usal) untouched - their role (light
 * standalone dish vs. thali accompaniment) is more ambiguous than a
 * straightforward poured-dal, so they're left for a human decision rather
 * than guessed at here.
 *
 * Purely additive: appends 'side' to each recipe's existing `tags` array
 * (none of these currently have any tags - verified before writing this
 * script) rather than replacing it, so a future non-side tag on any of
 * these wouldn't be clobbered by a re-run.
 *
 * Saves through the master Recipe document (never RecipeVersion directly,
 * per recipe-database's "audit fixes go through the master Recipe document"
 * convention - the same applies to any fix here, and `tags` isn't even
 * mirrored onto RecipeVersion/the AI prompt pool anyway - both read `tags`
 * from the live Recipe document directly, see
 * services/menuGenerationService.js's buildEligibleV1Pool and
 * controllers/dietician/dietPlanController.js's recipeToPromptShape) and
 * explicitly awaits syncV1FromRecipe after each save, same pattern as
 * scripts/backfill-hand-authored-recipe-steps.js - the post-save hook is
 * fire-and-forget and can lose a race against mongoose.disconnect() on the
 * last document(s) written otherwise.
 *
 * Not scoped to one dietician's _id - this is a general catalog fix
 * regardless of which dietician owns the recipe, same reasoning as
 * scripts/backfill-recipe-core-roles.js.
 *
 * Connects via connectDB() (config/database.js), not a raw mongoose.connect()
 * - required against prod's self-hosted Mongo. Meant to be run directly
 * wherever MONGODB_URI already points at the target DB - e.g. Coolify's
 * Terminal tab for prod.
 *
 * Idempotent: re-running only ever touches recipes that don't already carry
 * the 'side' tag.
 *
 * Usage:
 *   node scripts/backfill-dal-side-tags.js              # dry run
 *   node scripts/backfill-dal-side-tags.js --execute     # write
 */
require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/database');

const EXECUTE = process.argv.includes('--execute');

// Poured/ladled dal-and-legume-curry dishes meant to accompany a
// sabji+bread+rice combo, exactly the role Varan and Sambar already play -
// see this file's header comment for what was deliberately left out and why.
const DAL_RECIPE_NAMES = [
  'Rajma',
  'Chole',
  'Dal Tadka',
  'Masoor Dal',
  'Whole Masoor Dal',
  'Chana Dal',
  'Dal Palak',
  'Palak Dal',
  'Methi Dal',
  'Light Dal Makhani',
];

async function main() {
  console.log(EXECUTE ? '=== EXECUTING dal side-tag backfill ===' : '=== DRY RUN (pass --execute to write) ===');
  console.log('Connecting to MongoDB...');
  await connectDB();
  console.log('Connected.');

  try {
    const { Recipe } = require('../models');
    const { syncV1FromRecipe } = require('../services/recipeVersioningService');

    const recipes = await Recipe.find({ name: { $in: DAL_RECIPE_NAMES } });
    console.log(`Found ${recipes.length}/${DAL_RECIPE_NAMES.length} named recipes in the catalog.\n`);

    const foundNames = new Set(recipes.map((r) => r.name));
    DAL_RECIPE_NAMES.filter((n) => !foundNames.has(n)).forEach((n) => console.log(`NOT FOUND (skipping): "${n}"`));

    let updated = 0;
    let skipped = 0;
    let failed = 0;

    for (const recipe of recipes) {
      const currentTags = recipe.tags || [];
      if (currentTags.includes('side')) {
        console.log(`SKIP (already tagged 'side'): "${recipe.name}"`);
        skipped++;
        continue;
      }

      const newTags = [...currentTags, 'side'];
      console.log(`"${recipe.name}" [${recipe.servingTime}] tags: ${JSON.stringify(currentTags)} -> ${JSON.stringify(newTags)}`);

      if (EXECUTE) {
        try {
          recipe.tags = newTags;
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
      `\n=== ${EXECUTE ? 'DONE' : 'DRY RUN DONE'} === total=${recipes.length} updated=${updated} skipped=${skipped} failed=${failed}`
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
