/**
 * Read-only audit of Recipe.components vs Recipe.ingredients consistency
 * across the catalog - see openspec/changes/
 * unify-recipe-ingredients-and-components for the full rationale.
 *
 * Classifies every recipe with a non-empty `components` into one of three
 * buckets, by matching each component's `label` against `ingredients[].name`
 * (case/whitespace-insensitive, English names only - never a translation):
 *
 *   - auto-migratable:    EVERY component matches an ingredient. Safe for
 *                         scripts/unify-recipe-components-into-ingredients.js
 *                         to set `ingredients[].role = 'core'` on the
 *                         matched entries.
 *   - needs-manual-review: SOME (not all) components match. Genuinely
 *                         ambiguous between "ingredients is missing a few
 *                         entries" (the reported bug) and "this is a
 *                         composite dish with one coincidental name match" -
 *                         never auto-touched, always flagged for a
 *                         dietician to resolve by hand.
 *   - composite-exempt:   NO components match (or the recipe is already
 *                         explicitly flagged `componentsAuthoredManually:
 *                         true`) - a composite, multi-dish recipe (e.g.
 *                         "Pithla Bhakri") whose components name prepared
 *                         sub-dishes, not raw ingredients. Left alone by
 *                         design, not a failure.
 *
 * Recipes with no `components` at all are skipped entirely - nothing to
 * classify.
 *
 * Usage:
 *   node scripts/audit-recipe-components-drift.js            # human-readable summary
 *   node scripts/audit-recipe-components-drift.js --json      # full per-bucket recipe list as JSON
 */

require('dns').setServers(['8.8.8.8', '1.1.1.1']);
require('dotenv').config({ quiet: true });
const mongoose = require('mongoose');
const { componentsAreDerivable } = require('../utils/coreIngredientHeuristic');

const AS_JSON = process.argv.includes('--json');

const normalize = (s) => String(s || '').trim().toLowerCase();

/** Returns the fraction (0-1) of `components` whose label matches an ingredient name. */
function matchRatio(components, ingredients) {
  if (!Array.isArray(components) || components.length === 0) return null;
  const ingredientNames = new Set((ingredients || []).map((i) => normalize(i?.name)));
  const matched = components.filter((c) => ingredientNames.has(normalize(c?.label))).length;
  return matched / components.length;
}

function classify(recipe) {
  if (!Array.isArray(recipe.components) || recipe.components.length === 0) return null;
  if (recipe.componentsAuthoredManually === true) return 'composite-exempt';

  const ratio = matchRatio(recipe.components, recipe.ingredients);
  if (ratio === 1) return 'auto-migratable';
  if (ratio === 0) return 'composite-exempt';
  return 'needs-manual-review';
}

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  const Recipe = require('../models/Recipe');

  const recipes = await Recipe.find({})
    .select('name category servingTime status components ingredients componentsAuthoredManually')
    .lean();

  const buckets = { 'auto-migratable': [], 'needs-manual-review': [], 'composite-exempt': [] };
  for (const r of recipes) {
    const bucket = classify(r);
    if (bucket) buckets[bucket].push(r);
  }

  // Sanity check: the shared componentsAreDerivable helper should agree
  // with 'auto-migratable' exactly (ratio === 1) - if it doesn't, the audit
  // and the runtime pre-save hook have drifted from each other, which would
  // be a bug in this script, not in the data.
  for (const r of buckets['auto-migratable']) {
    if (!componentsAreDerivable(r.components, r.ingredients)) {
      console.warn(`WARNING: ${r.name} (${r._id}) classified auto-migratable but componentsAreDerivable disagrees - investigate.`);
    }
  }

  if (AS_JSON) {
    const toRow = (r) => ({
      id: String(r._id),
      name: r.name,
      category: r.category,
      servingTime: r.servingTime,
      status: r.status,
      components: r.components.map((c) => ({ label: c.label, quantity: c.quantity, unit: c.unit })),
      ingredientNames: (r.ingredients || []).map((i) => i.name),
    });
    console.log(
      JSON.stringify(
        {
          autoMigratable: buckets['auto-migratable'].map(toRow),
          needsManualReview: buckets['needs-manual-review'].map(toRow),
          compositeExempt: buckets['composite-exempt'].map(toRow),
        },
        null,
        2
      )
    );
    await mongoose.disconnect();
    return;
  }

  console.log(`DB: ${mongoose.connection.host} / ${mongoose.connection.name}`);
  console.log(`Total recipes: ${recipes.length}`);
  console.log(`Recipes with no components at all (skipped): ${recipes.length - Object.values(buckets).flat().length}`);
  console.log(`\nAuto-migratable (every component matches an ingredient): ${buckets['auto-migratable'].length}`);
  console.log(`  Note: this count reflects name-match quality, not "still needs migration" - it stays`);
  console.log(`  the same size after a recipe is migrated (role correctly set). To check whether any`);
  console.log(`  are still PENDING a role fix, run unify-recipe-components-into-ingredients.js in`);
  console.log(`  dry-run mode and look at its own "would be migrated" count instead.`);
  console.log(`Needs manual review (some but not all match):            ${buckets['needs-manual-review'].length}`);
  console.log(`Composite-exempt (none match / already manually-authored): ${buckets['composite-exempt'].length}`);

  if (buckets['needs-manual-review'].length > 0) {
    console.log('\n--- Needs manual review ---');
    buckets['needs-manual-review']
      .sort((a, b) => a.name.localeCompare(b.name))
      .forEach((r) => {
        const compLabels = r.components.map((c) => c.label).join(', ');
        const ingNames = (r.ingredients || []).map((i) => i.name).join(', ');
        console.log(`  ${r.name}  (${r.category} / ${r.servingTime})`);
        console.log(`    components:  ${compLabels}`);
        console.log(`    ingredients: ${ingNames}`);
      });
  }

  console.log(`\nAuto-migratable recipe names (run scripts/unify-recipe-components-into-ingredients.js to apply):`);
  buckets['auto-migratable']
    .sort((a, b) => a.name.localeCompare(b.name))
    .forEach((r) => console.log(`  ${r.name}`));

  await mongoose.disconnect();
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = { classify, matchRatio };
