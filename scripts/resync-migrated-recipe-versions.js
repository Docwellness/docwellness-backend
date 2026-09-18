/**
 * One-off remediation: re-syncs the V1 RecipeVersion for the 13 recipes
 * unify-recipe-components-into-ingredients.js already migrated on prod
 * (2026-09-18) - 4 of those syncs failed with "Operation interrupted
 * because client was closed" / "Cannot use a session that has ended"
 * because the migration script disconnected from MongoDB before its
 * fire-and-forget post-save RecipeVersion sync hooks finished (now fixed
 * in the migration script itself for future runs - this script only
 * remediates the recipes already touched by that earlier run).
 *
 * Safe to run more than once - syncV1FromRecipe is idempotent.
 *
 * Usage: node scripts/resync-migrated-recipe-versions.js
 */

require('dns').setServers(['8.8.8.8', '1.1.1.1']);
require('dotenv').config({ quiet: true });
const mongoose = require('mongoose');

const MIGRATED_RECIPE_NAMES = [
  'Apple with Roasted Sunflower Seeds and Raisins',
  'Lemongrass Tea',
  'Wheatgrass Juice with Lemon',
  'Watermelon Cucumber Salad',
  'Chana Dal',
  'Whole Masoor Dal',
  'Masoor Dal',
  'Ashwagandha Capsule',
  'Shatavari Capsule',
  'Triphala Tablet',
  'Chyawanprash',
  'Brahmi Capsule',
  'Guduchi Giloy Tablet',
];

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log(`Connected: ${mongoose.connection.host} / ${mongoose.connection.name}`);

  const { Recipe, RecipeVersion } = require('../models');
  const { syncV1FromRecipe } = require('../services/recipeVersioningService');

  const recipes = await Recipe.find({ name: { $in: MIGRATED_RECIPE_NAMES } });
  console.log(`Found ${recipes.length} of ${MIGRATED_RECIPE_NAMES.length} expected recipes.`);

  for (const recipe of recipes) {
    const before = await RecipeVersion.findOne({ parentRecipeId: recipe._id, versionNumber: 1 }).lean();
    const beforeHasCore = before?.ingredients?.some((i) => i.role === 'core') ?? null;

    await syncV1FromRecipe(recipe);

    const after = await RecipeVersion.findOne({ parentRecipeId: recipe._id, versionNumber: 1 }).lean();
    const afterHasCore = after?.ingredients?.some((i) => i.role === 'core') ?? false;

    console.log(
      `${recipe.name.padEnd(48)} before(core)=${String(beforeHasCore).padEnd(5)} after(core)=${afterHasCore}${afterHasCore ? '' : '  <-- STILL NO CORE INGREDIENT IN V1 - CHECK FoodItem MATCHING'}`
    );
  }

  const notFound = MIGRATED_RECIPE_NAMES.filter((n) => !recipes.some((r) => r.name === n));
  if (notFound.length) {
    console.log(`\nNOT FOUND (name mismatch? check manually): ${notFound.join(', ')}`);
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('Resync failed:', err);
  process.exit(1);
});
