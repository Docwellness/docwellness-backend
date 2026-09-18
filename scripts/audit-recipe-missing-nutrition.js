/**
 * Read-only audit: finds every active Recipe whose own `nutrition.calories`
 * is missing/null/zero (the exact field the dietician app's recipe editor
 * header reads - see recipeDescription in docwellness-dietician's
 * recipe_details.dart), and checks whether it CAN be safely backfilled from
 * its own V1 RecipeVersion.nutritionPerServing - the same deterministic,
 * FoodItem-based computation (services/recipeVersioningService.js's
 * computeNutritionFromIngredients) already trusted and shown to patients,
 * so backfilling from it can only make the dietician-facing number agree
 * with what patients already see, never introduce a new figure.
 *
 * Buckets:
 *   - backfillable: Recipe.nutrition.calories missing, V1 RecipeVersion has
 *     a real (non-null) nutritionPerServing.calories to copy from.
 *   - unresolvable: Recipe.nutrition.calories missing, and V1 either
 *     doesn't exist or itself has no resolvable nutrition (no FoodItem
 *     matches) - genuinely missing data, not something this script can fix.
 *
 * Usage:
 *   node scripts/audit-recipe-missing-nutrition.js            # human-readable summary
 *   node scripts/audit-recipe-missing-nutrition.js --json      # full per-bucket list as JSON
 */

require('dns').setServers(['8.8.8.8', '1.1.1.1']);
require('dotenv').config({ quiet: true });
const mongoose = require('mongoose');

const AS_JSON = process.argv.includes('--json');

function hasCalories(nutrition) {
  return typeof nutrition?.calories === 'number' && nutrition.calories > 0;
}

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  const Recipe = require('../models/Recipe');
  const RecipeVersion = require('../models/RecipeVersion');

  const recipes = await Recipe.find({ status: { $ne: 'Archived' } })
    .select('name category servingTime nutrition')
    .lean();

  const missing = recipes.filter((r) => !hasCalories(r.nutrition));
  console.log(`Scanning ${recipes.length} active recipes - ${missing.length} missing real calories on Recipe.nutrition.`);

  const backfillable = [];
  const unresolvable = [];

  for (const recipe of missing) {
    const v1 = await RecipeVersion.findOne({ parentRecipeId: recipe._id, versionNumber: 1 })
      .select('nutritionPerServing hasUnresolvedIngredients unresolvedIngredientNames')
      .lean();
    if (v1 && hasCalories(v1.nutritionPerServing)) {
      backfillable.push({ recipe, nutritionPerServing: v1.nutritionPerServing });
    } else {
      unresolvable.push({
        recipe,
        reason: !v1 ? 'no V1 RecipeVersion' : 'V1 itself has no resolvable calories',
        unresolvedIngredientNames: v1?.unresolvedIngredientNames || [],
      });
    }
  }

  if (AS_JSON) {
    console.log(
      JSON.stringify(
        {
          backfillable: backfillable.map((x) => ({
            id: String(x.recipe._id),
            name: x.recipe.name,
            nutritionPerServing: x.nutritionPerServing,
          })),
          unresolvable: unresolvable.map((x) => ({
            id: String(x.recipe._id),
            name: x.recipe.name,
            reason: x.reason,
            unresolvedIngredientNames: x.unresolvedIngredientNames,
          })),
        },
        null,
        2
      )
    );
    await mongoose.disconnect();
    return;
  }

  console.log(`\nBackfillable from V1 RecipeVersion (safe, deterministic): ${backfillable.length}`);
  console.log(`Unresolvable (genuinely missing nutrition data): ${unresolvable.length}`);

  if (backfillable.length) {
    console.log('\n--- Backfillable ---');
    backfillable
      .sort((a, b) => a.recipe.name.localeCompare(b.recipe.name))
      .forEach((x) => console.log(`  ${x.recipe.name}  ->  ${x.nutritionPerServing.calories} kcal`));
  }

  if (unresolvable.length) {
    console.log('\n--- Unresolvable (needs manual nutrition entry) ---');
    unresolvable
      .sort((a, b) => a.recipe.name.localeCompare(b.recipe.name))
      .forEach((x) => {
        console.log(`  ${x.recipe.name}  (${x.reason})`);
        if (x.unresolvedIngredientNames.length) {
          console.log(`    unresolved ingredients: ${x.unresolvedIngredientNames.join(', ')}`);
        }
      });
  }

  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
