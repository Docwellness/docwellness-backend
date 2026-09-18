/**
 * One-time backfill: for every recipe in audit-recipe-missing-nutrition.js's
 * "backfillable" bucket (Recipe.nutrition.calories missing/zero, but its
 * own V1 RecipeVersion has a real, resolved nutritionPerServing), copies
 * that same figure onto Recipe.nutrition/nutritionPerServing - the exact
 * deterministic, FoodItem-based computation already trusted and displayed
 * to patients (services/recipeVersioningService.js's
 * computeNutritionFromIngredients), so the dietician-facing recipe editor
 * header stops showing "0 calories" for a real dish and instead agrees
 * with what patients already see.
 *
 * Deliberately does NOT touch a recipe whose V1 itself has no resolvable
 * nutrition (e.g. supplements like "Ashwagandha Capsule" - 0 calories is
 * legitimately correct for those, see supplementFacts) or has none at all -
 * those need either a FoodItem catalog fix or manual nutrition entry, not a
 * guess.
 *
 * Usage:
 *   node scripts/backfill-recipe-nutrition-from-version.js            # dry run
 *   node scripts/backfill-recipe-nutrition-from-version.js --execute  # actually write
 */

require('dns').setServers(['8.8.8.8', '1.1.1.1']);
require('dotenv').config({ quiet: true });
const mongoose = require('mongoose');

const EXECUTE = process.argv.includes('--execute');

function hasCalories(nutrition) {
  return typeof nutrition?.calories === 'number' && nutrition.calories > 0;
}

async function main() {
  console.log(EXECUTE ? '=== EXECUTING nutrition backfill from V1 RecipeVersion ===' : '=== DRY RUN (pass --execute to write) ===');

  await mongoose.connect(process.env.MONGODB_URI);
  console.log(`Connected: ${mongoose.connection.host} / ${mongoose.connection.name}`);

  const Recipe = require('../models/Recipe');
  const RecipeVersion = require('../models/RecipeVersion');

  const recipes = await Recipe.find({ status: { $ne: 'Archived' } });
  console.log(`Scanning ${recipes.length} active recipes...`);

  let backfilled = 0;
  let skippedHasNutrition = 0;
  let skippedUnresolvable = 0;
  const changeLog = [];

  for (const recipe of recipes) {
    if (hasCalories(recipe.nutrition)) {
      skippedHasNutrition++;
      continue;
    }

    const v1 = await RecipeVersion.findOne({ parentRecipeId: recipe._id, versionNumber: 1 }).select('nutritionPerServing');
    if (!v1 || !hasCalories(v1.nutritionPerServing)) {
      skippedUnresolvable++;
      continue;
    }

    const nps = v1.nutritionPerServing;
    changeLog.push({
      recipe: recipe.name,
      from: recipe.nutrition?.calories ?? null,
      to: nps.calories,
    });
    backfilled++;

    if (EXECUTE) {
      recipe.nutrition = {
        calories: nps.calories,
        protein: nps.protein,
        carbs: nps.carbs,
        fats: nps.fats,
        fiber: nps.fiber,
      };
      // nutritionPerServing is recomputed by Recipe.js's own pre-save hook
      // from `nutrition` whenever it's modified - no need to set it directly.
      await recipe.save();
    }
  }

  console.log('\n=== CHANGES ===');
  console.table(changeLog);
  console.log(`\n${backfilled} recipe(s) ${EXECUTE ? 'backfilled' : 'would be backfilled'}.`);
  console.log(`${skippedHasNutrition} recipe(s) skipped (already has real calories).`);
  console.log(`${skippedUnresolvable} recipe(s) skipped (unresolvable - see audit-recipe-missing-nutrition.js).`);

  if (!EXECUTE) {
    console.log('\nThis was a dry run - nothing written. Re-run with --execute to actually apply.');
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
