/**
 * One-time catch-up for recipes that existed before Recipe.js's post-save
 * V1-sync hook (services/recipeVersioningService.js::syncV1FromRecipe) was
 * added - every recipe saved from now on gets its V1 RecipeVersion kept in
 * sync automatically, but historical recipes need this run once.
 *
 * Idempotent: syncV1FromRecipe itself upserts V1 in place (or bumps a new
 * version if a PlanItem already references the current V1), so re-running
 * this script is always safe.
 *
 * Usage:
 *   node scripts/backfill-recipe-versions.js            # dry run (report only)
 *   node scripts/backfill-recipe-versions.js --execute  # actually create/update RecipeVersions
 *   node scripts/backfill-recipe-versions.js --verify   # re-derive nutritionPerServing from
 *                                                        # stored ingredients[] + current
 *                                                        # FoodItem data and diff against the
 *                                                        # cached value on each RecipeVersion -
 *                                                        # catches drift if FoodItem nutrition
 *                                                        # was corrected after a version was
 *                                                        # created. Never writes.
 */

require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/database');

const EXECUTE = process.argv.includes('--execute');
const VERIFY = process.argv.includes('--verify');

async function runBackfill() {
  const { Recipe, FoodItem, RecipeVersion } = require('../models');
  const { syncV1FromRecipe } = require('../services/recipeVersioningService');

  const recipes = await Recipe.find({ category: { $ne: 'Supplements' } });
  console.log(`Found ${recipes.length} non-Supplement recipe(s).`);

  let created = 0;
  let updated = 0;
  let unresolved = 0;
  let skippedNoIngredients = 0;

  for (const recipe of recipes) {
    if (!recipe.ingredients?.length) {
      skippedNoIngredients += 1;
      continue;
    }
    const before = await RecipeVersion.findOne({ parentRecipeId: recipe._id, versionNumber: 1 });
    if (!EXECUTE) {
      // Dry run: report what WOULD happen without calling syncV1FromRecipe
      // (which writes), by resolving names the same way it does.
      const { normalize } = require('../utils/ingredientLibrary');
      const normalizedNames = recipe.ingredients.map((i) => normalize(i.name));
      const foodItems = await FoodItem.find({ normalizedName: { $in: normalizedNames } });
      const matchedNames = new Set(foodItems.map((f) => f.normalizedName));
      const anyUnmatched = recipe.ingredients.some((i) => !matchedNames.has(normalize(i.name)));
      if (anyUnmatched) unresolved += 1;
      if (before) updated += 1;
      else created += 1;
      continue;
    }
    const result = await syncV1FromRecipe(recipe);
    if (!result) continue;
    if (before) updated += 1;
    else created += 1;
    if (result.hasUnresolvedIngredients) unresolved += 1;
  }

  console.log(EXECUTE ? '\n=== EXECUTED ===' : '\n=== DRY RUN (pass --execute to write) ===');
  console.log(`RecipeVersion V1 created: ${created}`);
  console.log(`RecipeVersion V1 updated/refreshed: ${updated}`);
  console.log(`Recipes with unresolved ingredients (needs FoodItem data): ${unresolved}`);
  console.log(`Recipes skipped (no ingredients array): ${skippedNoIngredients}`);
}

async function runVerify() {
  const { FoodItem, RecipeVersion } = require('../models');
  const { computeNutritionFromIngredients } = require('../services/recipeVersioningService');

  const versions = await RecipeVersion.find({});
  console.log(`Checking ${versions.length} RecipeVersion document(s) for nutrition drift...`);

  let matched = 0;
  let drifted = 0;

  for (const version of versions) {
    const foodItemIds = version.ingredients.map((i) => i.foodItemId);
    const foodItems = await FoodItem.find({ _id: { $in: foodItemIds } });
    const foodItemsById = new Map(foodItems.map((f) => [String(f._id), f]));
    const recomputed = computeNutritionFromIngredients(version.ingredients, foodItemsById);

    const storedCalories = version.nutritionPerServing?.calories;
    const recomputedCalories = recomputed.nutritionPerServing.calories;
    const isClose =
      (storedCalories === null && recomputedCalories === null) ||
      (typeof storedCalories === 'number' && typeof recomputedCalories === 'number' && Math.abs(storedCalories - recomputedCalories) < 0.5);

    if (isClose) {
      matched += 1;
    } else {
      drifted += 1;
      console.log(
        `  DRIFT: RecipeVersion ${version._id} (${version.name} v${version.versionNumber}): stored calories=${storedCalories}, recomputed=${recomputedCalories} - flag for dietician re-review, do NOT auto-update a possibly-already-prescribed version.`
      );
    }
  }

  console.log(`\n=== VERIFY: ${matched}/${versions.length} match, ${drifted} drifted ===`);
}

async function main() {
  console.log('Connecting to MongoDB...');
  const tlsCAFile = connectDB.resolveTlsCAFile();
  const connectOptions = tlsCAFile ? { tls: true, tlsCAFile } : {};
  await mongoose.connect(process.env.MONGODB_URI, connectOptions);
  console.log('Connected.');

  try {
    if (VERIFY) {
      await runVerify();
    } else {
      await runBackfill();
    }
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
