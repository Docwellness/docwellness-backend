/**
 * One-off backfill for RecipeVersion.components, added after the field
 * itself (models/RecipeVersion.js) - every RecipeVersion created from now on
 * gets `components` automatically (services/recipeVersioningService.js's
 * syncV1FromRecipe/createCustomVersion), but a version created BEFORE this
 * field existed has components: [] and, per syncV1FromRecipe's freeze
 * semantics, will never be updated in place again once any PlanItem
 * references it - so historical versions need this run once.
 *
 * Purely additive display data (the real-world serving-unit label, e.g. "2
 * piece") - never touches ingredients/rawQuantity/nutritionPerServing, i.e.
 * never changes what's actually prescribed to a patient, only what label is
 * shown alongside it. Idempotent: only touches documents with an empty
 * components array.
 *
 * V1 versions are copied directly from the parent Recipe's own components
 * (exactly what syncV1FromRecipe does for a fresh V1). V2+ versions are
 * best-effort scaled by (this version's calories / the parent Recipe's own
 * authored calories) - an approximation, not the exact compounding ratio
 * createCustomVersion would have applied at each edit step, since that
 * per-step history isn't reconstructable after the fact. Logged clearly so
 * a dietician can spot-check any V2+ result that looks off.
 *
 * Usage:
 *   node scripts/backfill-recipe-version-components.js            # dry run (report only)
 *   node scripts/backfill-recipe-version-components.js --execute  # actually write
 */

require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/database');

const EXECUTE = process.argv.includes('--execute');

async function run() {
  const { Recipe, RecipeVersion } = require('../models');

  const versions = await RecipeVersion.find({
    $or: [{ components: { $exists: false } }, { components: { $size: 0 } }],
  });
  console.log(`Found ${versions.length} RecipeVersion(s) with no components.`);

  const recipeIds = [...new Set(versions.map((v) => String(v.parentRecipeId)))];
  const recipes = await Recipe.find({ _id: { $in: recipeIds } }).select('components nutrition');
  const recipeById = new Map(recipes.map((r) => [String(r._id), r]));

  let updatedV1 = 0;
  let updatedScaled = 0;
  let skippedNoRecipeComponents = 0;
  let skippedNoRecipe = 0;

  for (const version of versions) {
    const recipe = recipeById.get(String(version.parentRecipeId));
    if (!recipe) {
      skippedNoRecipe += 1;
      continue;
    }
    if (!recipe.components?.length) {
      skippedNoRecipeComponents += 1;
      continue;
    }

    let components;
    if (version.versionNumber === 1) {
      components = recipe.components;
      updatedV1 += 1;
    } else {
      const baseCalories = recipe.nutrition?.calories;
      const versionCalories = version.nutritionPerServing?.calories;
      const ratio = baseCalories > 0 && versionCalories > 0 ? versionCalories / baseCalories : 1;
      components = recipe.components.map((c) => ({
        label: c.label,
        quantity: Math.round(c.quantity * ratio * 100) / 100,
        unit: c.unit,
      }));
      updatedScaled += 1;
      console.log(
        `  V${version.versionNumber} ${version.name} (${version._id}): approximated ratio ${ratio.toFixed(2)} from recipe.nutrition.calories - spot-check this one.`
      );
    }

    if (EXECUTE) {
      await RecipeVersion.updateOne({ _id: version._id }, { $set: { components } });
    }
  }

  console.log(EXECUTE ? '\n=== EXECUTED ===' : '\n=== DRY RUN (pass --execute to write) ===');
  console.log(`V1 versions backfilled (exact copy): ${updatedV1}`);
  console.log(`V2+ versions backfilled (ratio-approximated): ${updatedScaled}`);
  console.log(`Skipped - parent Recipe has no components: ${skippedNoRecipeComponents}`);
  console.log(`Skipped - parent Recipe not found: ${skippedNoRecipe}`);
}

async function main() {
  console.log('Connecting to MongoDB...');
  const tlsCAFile = connectDB.resolveTlsCAFile();
  const connectOptions = tlsCAFile ? { tls: true, tlsCAFile } : {};
  await mongoose.connect(process.env.MONGODB_URI, connectOptions);
  console.log('Connected.');

  try {
    await run();
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
