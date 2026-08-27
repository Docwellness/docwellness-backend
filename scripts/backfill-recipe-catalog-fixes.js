/**
 * ALL-INCLUSIVE prod backfill combining every catalog-data fix from this
 * round of work. One script, one Coolify Terminal run, three independent
 * steps (a failure/skip in one never blocks the others). ZERO AI calls at
 * runtime - safe to run inside Coolify's Scheduled Task/one-off job runner
 * (no Terminal tab in this deployment, no streaming output, unknown
 * execution timeout - see scripts/apply-precomputed-cooking-steps.js's own
 * header comment for the full rationale behind this "generate once
 * locally, apply as plain data on prod" pattern, which STEP 3 below
 * follows).
 *
 * STEP 1 - Dal side-tag backfill. Root cause of "Varan shows up for every
 * Lunch and Dinner": only Varan and Sambar were ever tagged
 * tags:['side'], so they were the ONLY dal/legume-curry candidates
 * eligible for the "dal" slot of a generated combo meal (see
 * utils/dietPlanOptions.js's SIDE_SALAD_ELIGIBLE_SLOTS broadening and the
 * AI prompt's combo rule). Retags 10 more real dals (Rajma, Chole, Dal
 * Tadka, Masoor Dal, Chana Dal, Whole Masoor Dal, Dal Palak, Palak Dal,
 * Methi Dal, Light Dal Makhani) so there's real variety to rotate through.
 * Deterministic - no AI calls.
 *
 * STEP 2 - Mechanical `components` migration from legacy servingSize - for
 * any recipe that has a real servingSize.quantity/unit but no `components`
 * yet, promotes servingSize (and secondaryComponent, if present) into
 * components[0]/[1]. Deterministic - no AI calls.
 *
 * STEP 3 - Applies the pre-generated `components` in
 * scripts/data/hand-authored-batch-1-components.json to the ~99 recipes
 * that have NEITHER `components` NOR a usable servingSize (STEP 2 has
 * nothing to migrate them from) - this is the "Makes (on the plate)"
 * badge showing nothing/defaulting to a meaningless "1 g" placeholder in
 * the app. That data was generated once, locally, against dev via
 * scripts/generate-precomputed-recipe-components.js (using
 * utils/openaiClient.js's generateComponentsForFixedIngredients - a
 * narrow AI call scoped to author ONLY `components` for a FIXED,
 * already-trusted ingredient list, never touching
 * ingredients/nutrition/quantities) and verified correct before being
 * committed here - see that script's own header comment for provenance,
 * and re-run it (locally, never on prod) to regenerate this data file if
 * the underlying recipe catalog changes enough to need it. Plain,
 * fast DB writes only at runtime, matched by recipe `name`.
 *
 * Every step saves through the master Recipe document (never RecipeVersion
 * directly, per recipe-database's "audit fixes go through the master
 * Recipe document" convention) and explicitly awaits syncV1FromRecipe
 * after each save - the post-save hook is fire-and-forget and can lose a
 * race against mongoose.disconnect() on the last document(s) written
 * otherwise.
 *
 * Not scoped to one dietician's _id - every step here is a general catalog
 * fix regardless of which dietician owns the recipe, same reasoning as
 * scripts/backfill-recipe-core-roles.js.
 *
 * Connects via connectDB() (config/database.js), not a raw
 * mongoose.connect() - required against prod's self-hosted Mongo. Meant to
 * be run directly wherever MONGODB_URI already points at the target DB -
 * e.g. Coolify's Terminal tab for prod.
 *
 * Idempotent - every step only touches recipes still missing that step's
 * specific fix, so re-running converges on the same end state.
 *
 * Usage:
 *   node scripts/backfill-recipe-catalog-fixes.js              # dry run, all steps
 *   node scripts/backfill-recipe-catalog-fixes.js --execute     # write, all steps
 */
require('dotenv').config();
const path = require('path');
const mongoose = require('mongoose');
const connectDB = require('../config/database');

const EXECUTE = process.argv.includes('--execute');

// STEP 1 data - see this file's own header comment for why this exact
// list and why Khichdi/usal-type dishes are excluded.
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

// STEP 3 data - see this file's own header comment on provenance.
const PRECOMPUTED_COMPONENTS = require(path.join(__dirname, 'data', 'hand-authored-batch-1-components.json'));

async function stepDalSideTags({ Recipe, syncV1FromRecipe }) {
  console.log('\n--- STEP 1: dal side-tag backfill ---');
  const recipes = await Recipe.find({ name: { $in: DAL_RECIPE_NAMES } });
  console.log(`Found ${recipes.length}/${DAL_RECIPE_NAMES.length} named recipes in the catalog.`);
  DAL_RECIPE_NAMES.filter((n) => !recipes.some((r) => r.name === n)).forEach((n) =>
    console.log(`  NOT FOUND (skipping): "${n}"`)
  );

  let updated = 0;
  let skipped = 0;
  let failed = 0;

  for (const recipe of recipes) {
    const currentTags = recipe.tags || [];
    if (currentTags.includes('side')) {
      console.log(`  SKIP (already tagged 'side'): "${recipe.name}"`);
      skipped++;
      continue;
    }

    const newTags = [...currentTags, 'side'];
    console.log(`  "${recipe.name}" [${recipe.servingTime}] tags: ${JSON.stringify(currentTags)} -> ${JSON.stringify(newTags)}`);

    if (EXECUTE) {
      try {
        recipe.tags = newTags;
        await recipe.save();
        await syncV1FromRecipe(recipe);
        updated++;
      } catch (err) {
        console.error(`    FAILED to save "${recipe.name}": ${err.message}`);
        failed++;
      }
    }
  }

  console.log(`STEP 1 ${EXECUTE ? 'DONE' : 'DRY RUN'}: total=${recipes.length} updated=${updated} skipped=${skipped} failed=${failed}`);
  return { total: recipes.length, updated, skipped, failed };
}

async function stepMechanicalComponents({ Recipe, syncV1FromRecipe }) {
  console.log('\n--- STEP 2: mechanical components migration (from servingSize) ---');
  const recipes = await Recipe.find({
    $or: [{ components: { $exists: false } }, { components: { $size: 0 } }],
  });
  console.log(`Found ${recipes.length} recipe(s) with no components yet.`);

  let updated = 0;
  let skippedNoServingSize = 0;
  let failed = 0;

  for (const recipe of recipes) {
    const quantity = recipe.servingSize?.quantity;
    const unit = recipe.servingSize?.unit;
    if (!(quantity > 0) || !unit) {
      skippedNoServingSize++; // handled by STEP 3 instead
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

    console.log(`  "${recipe.name}" -> components: ${JSON.stringify(components)}`);

    if (EXECUTE) {
      try {
        recipe.components = components;
        await recipe.save();
        await syncV1FromRecipe(recipe);
        updated++;
      } catch (err) {
        console.error(`    FAILED to save "${recipe.name}": ${err.message}`);
        failed++;
      }
    }
  }

  console.log(
    `STEP 2 ${EXECUTE ? 'DONE' : 'DRY RUN'}: total=${recipes.length} updated=${updated} skippedNoServingSize=${skippedNoServingSize} (-> STEP 3) failed=${failed}`
  );
  return { total: recipes.length, updated, skippedNoServingSize, failed };
}

async function stepPrecomputedComponents({ Recipe, syncV1FromRecipe }) {
  console.log('\n--- STEP 3: apply precomputed components (no AI calls) ---');
  console.log(`Loaded ${PRECOMPUTED_COMPONENTS.length} precomputed recipe(s).`);

  let updated = 0;
  let skipped = 0;
  let missing = 0;
  let failed = 0;

  for (const entry of PRECOMPUTED_COMPONENTS) {
    const recipe = await Recipe.findOne({ name: entry.name });
    if (!recipe) {
      console.log(`  MISSING (no matching recipe on this DB): "${entry.name}"`);
      missing++;
      continue;
    }
    if (Array.isArray(recipe.components) && recipe.components.length > 0) {
      console.log(`  SKIP (already has components): "${entry.name}"`);
      skipped++;
      continue;
    }

    console.log(`  "${entry.name}" [${entry.servingTime}] -> ${JSON.stringify(entry.components)}`);

    if (EXECUTE) {
      try {
        recipe.components = entry.components;
        await recipe.save();
        await syncV1FromRecipe(recipe);
        updated++;
      } catch (err) {
        console.error(`    FAILED to save "${entry.name}": ${err.message}`);
        failed++;
      }
    }
  }

  console.log(
    `STEP 3 ${EXECUTE ? 'DONE' : 'DRY RUN'}: total=${PRECOMPUTED_COMPONENTS.length} updated=${updated} skipped=${skipped} missing=${missing} failed=${failed}`
  );
  return { total: PRECOMPUTED_COMPONENTS.length, updated, skipped, missing, failed };
}

async function main() {
  console.log(EXECUTE ? '=== EXECUTING recipe catalog fixes ===' : '=== DRY RUN (pass --execute to write) ===');
  console.log('Connecting to MongoDB...');
  await connectDB();
  console.log('Connected.');

  try {
    const { Recipe } = require('../models');
    const { syncV1FromRecipe } = require('../services/recipeVersioningService');

    const step1 = await stepDalSideTags({ Recipe, syncV1FromRecipe });
    const step2 = await stepMechanicalComponents({ Recipe, syncV1FromRecipe });
    const step3 = await stepPrecomputedComponents({ Recipe, syncV1FromRecipe });

    console.log(`\n=== ${EXECUTE ? 'ALL STEPS DONE' : 'DRY RUN COMPLETE'} ===`);
    console.log(`  STEP 1 (dal side-tags):         updated=${step1.updated} skipped=${step1.skipped} failed=${step1.failed}`);
    console.log(`  STEP 2 (mechanical components): updated=${step2.updated} failed=${step2.failed}`);
    console.log(`  STEP 3 (precomputed components): updated=${step3.updated} skipped=${step3.skipped} missing=${step3.missing} failed=${step3.failed}`);
  } finally {
    await mongoose.disconnect();
    console.log('Disconnected from MongoDB.');
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
