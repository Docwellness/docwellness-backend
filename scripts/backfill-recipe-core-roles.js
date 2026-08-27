/**
 * Backfills `role: 'core'|'sub'` on every existing Recipe's ingredients that
 * predates the recipe-core-ingredient-scaling feature (see
 * openspec/changes/archive/2026-08-27-recipe-core-ingredient-scaling and its
 * sibling docwellness-dietician change) and so has no ingredient marked
 * `role: 'core'` yet - the "not-yet-migrated" case both specs explicitly
 * treat as a graceful no-op fallback rather than an error. Without this
 * backfill, every recipe that existed before the feature shipped just keeps
 * silently skipping the live core/sub scaling behavior forever (nothing
 * ever fails - it only ever stays inert), so this exists purely to close
 * that migration gap and light the feature up for the existing catalog too.
 *
 * Deterministic, not AI: reuses the exact same category-priority heuristic
 * (utils/coreIngredientHeuristic.js's applyCoreIngredientHeuristic) already
 * used for a zero-core AI response and for a manually authored recipe with
 * no explicit role - see recipe-database spec's "Every recipe designates at
 * least one core ingredient" requirement for the full category order and
 * rationale. Every ingredient in the single highest-priority category
 * present becomes `core`, together (so e.g. a Mixed Vegetable dish's whole
 * vegetable group becomes core as a unit, not just one of them).
 *
 * Finds candidates by loading each Recipe through Mongoose (not a raw
 * driver query) and checking hasCoreIngredient() on the hydrated result -
 * `role` has a schema default of 'sub', so a legacy document that never
 * had this field written to disk at all still hydrates every ingredient to
 * `role: 'sub'` when loaded, which is exactly the "not yet migrated" state
 * this script is looking for. A raw `{'ingredients.role': 'core'}` query
 * would miss that distinction entirely (defaults are a Mongoose-time
 * concept, not stored on disk), so this deliberately loads-then-filters in
 * JS instead of trying to express the check in the query itself.
 *
 * Saves through the master Recipe document (never RecipeVersion directly,
 * per recipe-database's "Viruddha Aahara audit fixes go through the master
 * Recipe document" requirement - the same convention applies to any fix
 * here) and explicitly awaits syncV1FromRecipe after each save, same
 * pattern as scripts/fix-viruddha-audit-recipes.js and
 * scripts/backfill-hand-authored-recipe-steps.js - the post-save hook is
 * fire-and-forget and can lose a race against mongoose.disconnect() on the
 * last document(s) written otherwise. syncV1FromRecipe's own freeze
 * semantics mean a recipe already referenced by a PlanItem gets a brand new
 * RecipeVersion instead of an in-place V1 rewrite - correct here too: an
 * already-prescribed plan's specific RecipeVersion is left untouched
 * (matches every other fix script's "never mutate what's already
 * prescribed" rule), and the dietician only sees live core/sub scaling for
 * that specific plan item once they next re-save/re-version it.
 *
 * Deliberately NOT scoped to one dietician's _id (unlike
 * backfill-hand-authored-recipe-steps.js, which targeted one specific
 * hand-authored batch) - this is a general schema migration for every
 * Recipe document regardless of which dietician owns it.
 *
 * Connects via connectDB() (config/database.js), not a raw mongoose.connect()
 * - required against prod's self-hosted Mongo, which needs the custom TLS CA
 * only connectDB() knows how to resolve. Meant to be run directly wherever
 * MONGODB_URI already points at the target DB - e.g. Coolify's Terminal tab
 * for prod (its Scheduled Tasks command field is a varchar(255) column, see
 * scripts/lookup-dietician-id.js's own history for why that one exists) -
 * not from a machine that can't reach that DB at all (prod's Mongo has no
 * public IP).
 *
 * Idempotent: re-running only ever processes recipes still missing a core
 * ingredient designation.
 *
 * --limit=N processes at most N recipes this run instead of all of them -
 * same reasoning as backfill-hand-authored-recipe-steps.js's own --limit
 * (a Coolify Scheduled Task/one-off job has no streaming terminal and an
 * unknown runtime cap). No AI calls here though (purely deterministic), so
 * a --limit is far less likely to be needed than it was for that script -
 * included anyway for consistency and as a safety valve on a very large
 * catalog.
 *
 * Usage:
 *   node scripts/backfill-recipe-core-roles.js                       # dry run, all of them
 *   node scripts/backfill-recipe-core-roles.js --execute             # write, all of them
 *   node scripts/backfill-recipe-core-roles.js --execute --limit=50  # write only the next 50, re-run to continue
 */
require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/database');

const EXECUTE = process.argv.includes('--execute');
const limitArg = process.argv.find((a) => a.startsWith('--limit='));
const LIMIT = limitArg ? parseInt(limitArg.split('=')[1], 10) : null;

async function main() {
  console.log(EXECUTE ? '=== EXECUTING core/sub role backfill ===' : '=== DRY RUN (pass --execute to write) ===');
  console.log('Connecting to MongoDB...');
  await connectDB();
  console.log('Connected.');

  try {
    const { Recipe } = require('../models');
    const { applyCoreIngredientHeuristic, hasCoreIngredient } = require('../utils/coreIngredientHeuristic');
    const { syncV1FromRecipe } = require('../services/recipeVersioningService');

    const allRecipes = await Recipe.find({ 'ingredients.0': { $exists: true } }).sort({ _id: 1 });
    let recipes = allRecipes.filter((recipe) => !hasCoreIngredient(recipe.ingredients));
    const totalCandidates = recipes.length;
    if (LIMIT) recipes = recipes.slice(0, LIMIT);

    console.log(
      `Found ${totalCandidates} recipe(s) with no core ingredient designated out of ${allRecipes.length} total` +
        `${LIMIT ? ` (processing ${recipes.length} this run, --limit=${LIMIT})` : ''}.\n`
    );

    let updated = 0;
    let failed = 0;

    for (const recipe of recipes) {
      // Re-check in case a prior iteration in this same run already fixed a
      // duplicate-named doc, or a concurrent process wrote it.
      if (hasCoreIngredient(recipe.ingredients)) {
        console.log(`SKIP (already has a core ingredient): "${recipe.name}"`);
        continue;
      }

      const plainIngredients = recipe.ingredients.map((ingredient) => ({
        name: ingredient.name,
        category: ingredient.category,
      }));
      const corrected = applyCoreIngredientHeuristic(plainIngredients);
      const coreNames = corrected.filter((ingredient) => ingredient.role === 'core').map((ingredient) => ingredient.name);

      console.log(`"${recipe.name}" [${recipe.category}/${recipe.servingTime}] -> core: ${coreNames.join(', ') || '(none?!)'}`);

      if (EXECUTE) {
        try {
          corrected.forEach((ingredient, idx) => {
            recipe.ingredients[idx].role = ingredient.role;
          });
          recipe.markModified('ingredients');
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
