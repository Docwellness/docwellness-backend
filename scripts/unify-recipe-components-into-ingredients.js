/**
 * One-time migration: for every recipe classified "auto-migratable" by
 * scripts/audit-recipe-components-drift.js (every `components[i].label`
 * matches an `ingredients[].name`), sets `role: 'core'` on each matched
 * ingredient, then `.save()`s the document so Recipe.js's pre-save hook
 * takes over from there - re-deriving `components`/`servingSize`/
 * `secondaryComponent` from the now-correctly-`role`-tagged ingredients,
 * and the post-save hook re-syncing the recipe's V1 RecipeVersion. See
 * openspec/changes/unify-recipe-ingredients-and-components for the full
 * rationale.
 *
 * Recipes in the "needs-manual-review" or "composite-exempt" buckets are
 * NEVER touched by this script - by design, not as a TODO. See the audit
 * script's own doc comment for why (match-ratio-based auto-healing risks
 * either silently missing a composite dish's real portions, or corrupting
 * one by treating a prepared sub-dish name as a raw grocery ingredient).
 *
 * Ingredients not referenced by any component keep their existing `role`
 * untouched (e.g. Water stays 'sub', or whatever it already was).
 *
 * Usage:
 *   node scripts/unify-recipe-components-into-ingredients.js            # dry run
 *   node scripts/unify-recipe-components-into-ingredients.js --execute  # actually write
 */

require('dns').setServers(['8.8.8.8', '1.1.1.1']);
require('dotenv').config({ quiet: true });
const mongoose = require('mongoose');
const { classify } = require('./audit-recipe-components-drift');

const EXECUTE = process.argv.includes('--execute');

const normalize = (s) => String(s || '').trim().toLowerCase();

async function main() {
  console.log(EXECUTE ? '=== EXECUTING components -> ingredients[].role unification ===' : '=== DRY RUN (pass --execute to write) ===');

  await mongoose.connect(process.env.MONGODB_URI);
  console.log(`Connected: ${mongoose.connection.host} / ${mongoose.connection.name}`);

  const Recipe = require('../models/Recipe');

  const recipes = await Recipe.find({
    components: { $exists: true, $ne: [] },
    componentsAuthoredManually: { $ne: true },
  });

  console.log(`Scanning ${recipes.length} candidate recipes...`);

  let migrated = 0;
  let skippedNotAutoMigratable = 0;
  let skippedNoRoleChangeNeeded = 0;
  const changeLog = [];
  const errors = [];

  for (const recipe of recipes) {
    const bucket = classify(recipe);
    if (bucket !== 'auto-migratable') {
      skippedNotAutoMigratable++;
      continue;
    }

    const componentLabels = new Set(recipe.components.map((c) => normalize(c.label)));
    let roleChanged = false;
    const rolesSet = [];
    for (const ingredient of recipe.ingredients) {
      if (componentLabels.has(normalize(ingredient.name)) && ingredient.role !== 'core') {
        ingredient.role = 'core';
        roleChanged = true;
        rolesSet.push(ingredient.name);
      }
    }

    if (!roleChanged) {
      // Already fully migrated (every matched ingredient is already
      // role: 'core') - nothing to do, not an error.
      skippedNoRoleChangeNeeded++;
      continue;
    }

    migrated++;
    changeLog.push({ recipe: recipe.name, rolesSetToCore: rolesSet.join(', ') });

    if (EXECUTE) {
      try {
        // .save() runs Recipe.js's pre-save hook (re-derives
        // components/servingSize/secondaryComponent from the now-updated
        // ingredients, a no-op here since they already matched) and its
        // post-save hook (re-syncs the V1 RecipeVersion) automatically -
        // no separate explicit calls needed, unlike the findOneAndUpdate-
        // based controller paths.
        await recipe.save();
      } catch (err) {
        errors.push({ recipe: recipe.name, id: String(recipe._id), error: err.message });
      }
    }
  }

  console.log('\n=== CHANGES ===');
  console.table(changeLog);
  console.log(`\n${migrated} recipe(s) ${EXECUTE ? 'migrated' : 'would be migrated'}.`);
  console.log(`${skippedNotAutoMigratable} recipe(s) skipped (needs-manual-review or composite-exempt).`);
  console.log(`${skippedNoRoleChangeNeeded} recipe(s) skipped (already fully migrated).`);

  if (errors.length) {
    console.log(`\n${errors.length} ERROR(S) during save:`);
    errors.forEach((e) => console.log(`  ${e.recipe} (${e.id}): ${e.error}`));
  }

  if (!EXECUTE) {
    console.log('\nThis was a dry run - nothing written. Re-run with --execute to actually apply.');
    console.log('Run scripts/audit-recipe-components-drift.js first (and after) to see the full picture.');
  }

  await mongoose.disconnect();
  process.exit(errors.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
