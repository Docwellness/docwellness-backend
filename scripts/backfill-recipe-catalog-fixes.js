/**
 * ALL-INCLUSIVE prod backfill combining every catalog-data fix from this
 * round of work. One script, one Coolify Terminal run, three independent
 * steps (a failure/skip in one never blocks the others):
 *
 * STEP 1 - Dal side-tag backfill (scripts/backfill-dal-side-tags.js's exact
 * logic, inlined here). Root cause of "Varan shows up for every Lunch and
 * Dinner": only Varan and Sambar were ever tagged tags:['side'], so they
 * were the ONLY dal/legume-curry candidates eligible for the "dal" slot of
 * a generated combo meal (see utils/dietPlanOptions.js's
 * SIDE_SALAD_ELIGIBLE_SLOTS broadening and the AI prompt's combo rule).
 * Retags 10 more real dals (Rajma, Chole, Dal Tadka, Masoor Dal, Chana Dal,
 * Whole Masoor Dal, Dal Palak, Palak Dal, Methi Dal, Light Dal Makhani) so
 * there's real variety to rotate through. No AI calls - fast, deterministic.
 *
 * STEP 2 - Mechanical `components` migration from legacy servingSize
 * (scripts/migrate-recipe-components.js's exact logic, inlined here) - for
 * any recipe that has a real servingSize.quantity/unit but no `components`
 * yet, promotes servingSize (and secondaryComponent, if present) into
 * components[0]/[1]. No AI calls - fast, deterministic.
 *
 * STEP 3 - AI-generated `components` for recipes with NEITHER `components`
 * NOR a usable servingSize (step 2 has nothing to migrate them from) - this
 * is the "Makes (on the plate)" badge showing nothing/defaulting to a
 * meaningless "1 g" placeholder in the app. Uses the new
 * generateComponentsForFixedIngredients (utils/openaiClient.js), a narrow
 * AI call scoped to author ONLY `components` for a FIXED, already-trusted
 * ingredient list - never touches ingredients/nutrition/quantities. Same
 * "narrow sibling function" pattern as generateCookingStepsForFixedIngredients
 * (see scripts/backfill-hand-authored-recipe-steps.js, which fixed the
 * equivalent gap for `instructions`). Supports --limit for safer Coolify
 * one-off runs, since this is the one step making real AI calls.
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
 * specific fix, so re-running (or re-running with a bigger --limit to
 * continue where a capped run left off) converges on the same end state.
 *
 * Usage:
 *   node scripts/backfill-recipe-catalog-fixes.js                       # dry run, all steps, all recipes
 *   node scripts/backfill-recipe-catalog-fixes.js --execute             # write, all steps, all recipes
 *   node scripts/backfill-recipe-catalog-fixes.js --execute --limit=15  # write, cap STEP 3's AI calls at 15 this run
 */
require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/database');

const EXECUTE = process.argv.includes('--execute');
const limitArg = process.argv.find((a) => a.startsWith('--limit='));
const LIMIT = limitArg ? parseInt(limitArg.split('=')[1], 10) : null;

// STEP 1 data - see scripts/backfill-dal-side-tags.js's own header comment
// for why this exact list and why Khichdi/usal-type dishes are excluded.
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
      skippedNoServingSize++; // handled by STEP 3 instead, if it has ingredients to work from
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

async function stepAiComponents({ Recipe, syncV1FromRecipe, generateComponentsForFixedIngredients }) {
  console.log('\n--- STEP 3: AI-generated components (no components, no usable servingSize) ---');
  let query = Recipe.find({
    $or: [{ components: { $exists: false } }, { components: { $size: 0 } }],
  }).sort({ servingTime: 1, name: 1 });
  const allCandidates = (await query).filter((r) => !(r.servingSize?.quantity > 0 && r.servingSize?.unit));
  const totalCandidates = allCandidates.length;
  const recipes = LIMIT ? allCandidates.slice(0, LIMIT) : allCandidates;

  console.log(
    `Found ${totalCandidates} recipe(s) with no components and no usable servingSize` +
      `${LIMIT ? ` (processing ${recipes.length} this run, --limit=${LIMIT})` : ''}.`
  );

  let updated = 0;
  let failed = 0;

  for (const recipe of recipes) {
    // Re-check in case an earlier step/iteration in this same run already
    // fixed it (STEP 2 runs first and could have covered it if data
    // changed mid-run in a concurrent process).
    if (Array.isArray(recipe.components) && recipe.components.length > 0) {
      console.log(`  SKIP (already has components): "${recipe.name}"`);
      continue;
    }

    let components;
    try {
      components = await generateComponentsForFixedIngredients({
        name: recipe.name,
        servingTime: recipe.servingTime,
        category: recipe.category,
        ingredients: (recipe.ingredients || []).map((i) => ({ name: i.name, quantity: i.quantity, unit: i.unit })),
      });
    } catch (err) {
      console.error(`  FAILED to generate components for "${recipe.name}": ${err.message}`);
      failed++;
      continue;
    }

    if (!Array.isArray(components) || components.length === 0) {
      console.error(`  FAILED (no components returned) for "${recipe.name}"`);
      failed++;
      continue;
    }

    console.log(`  "${recipe.name}" [${recipe.servingTime}] -> ${JSON.stringify(components)}`);

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
    `STEP 3 ${EXECUTE ? 'DONE' : 'DRY RUN'}: total=${recipes.length} updated=${updated} failed=${failed}` +
      (LIMIT && totalCandidates > recipes.length ? ` (${totalCandidates - recipes.length} remaining - re-run to continue)` : '')
  );
  return { total: recipes.length, updated, failed };
}

async function main() {
  console.log(EXECUTE ? '=== EXECUTING recipe catalog fixes ===' : '=== DRY RUN (pass --execute to write) ===');
  console.log('Connecting to MongoDB...');
  await connectDB();
  console.log('Connected.');

  try {
    const { Recipe } = require('../models');
    const { syncV1FromRecipe } = require('../services/recipeVersioningService');
    const { generateComponentsForFixedIngredients } = require('../utils/openaiClient');

    const step1 = await stepDalSideTags({ Recipe, syncV1FromRecipe });
    const step2 = await stepMechanicalComponents({ Recipe, syncV1FromRecipe });
    const step3 = await stepAiComponents({ Recipe, syncV1FromRecipe, generateComponentsForFixedIngredients });

    console.log(`\n=== ${EXECUTE ? 'ALL STEPS DONE' : 'DRY RUN COMPLETE'} ===`);
    console.log(`  STEP 1 (dal side-tags):        updated=${step1.updated} skipped=${step1.skipped} failed=${step1.failed}`);
    console.log(`  STEP 2 (mechanical components): updated=${step2.updated} failed=${step2.failed}`);
    console.log(`  STEP 3 (AI components):         updated=${step3.updated} failed=${step3.failed}`);
  } finally {
    await mongoose.disconnect();
    console.log('Disconnected from MongoDB.');
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
