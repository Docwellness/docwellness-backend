/**
 * One-time data repair: syncs each Recipe's `ingredients[]` quantity/unit
 * to match its `components[]` (by name) wherever they've drifted apart -
 * the same drift recipe_model.dart's RecipePreview._syncedIngredients now
 * prevents going forward (see docwellness-dietician's "Edit Portions"
 * fix), but that fix only applies the moment someone re-saves a recipe's
 * portions - it does nothing for recipes that already had `ingredients`
 * and `components` disagree with each other before that fix existed.
 *
 * Concretely: a recipe's `components` says "Brown Bread: 2 slice" (the
 * real, dietician-corrected portion), but `ingredients` - what the
 * grocery-list aggregation (dietController.js's buildGroceryItemsForWeek)
 * actually reads - still says "Brown Bread: 2 g", a nonsensical leftover
 * from before the recipe's portions were ever corrected.
 *
 * Usage:
 *   node scripts/sync-recipe-ingredients-with-components.js            # dry run
 *   node scripts/sync-recipe-ingredients-with-components.js --execute  # actually write
 */

require('dns').setServers(['8.8.8.8', '1.1.1.1']);
require('dotenv').config();
const connectDB = require('../config/database');

const EXECUTE = process.argv.includes('--execute');

async function main() {
  console.log(EXECUTE ? '=== EXECUTING ingredient/component sync ===' : '=== DRY RUN (pass --execute to write) ===');

  await connectDB();
  console.log('Connected.');

  const { Recipe } = require('../models');

  const recipes = await Recipe.find({
    components: { $exists: true, $ne: [] },
    ingredients: { $exists: true, $ne: [] },
  }).select('name components ingredients');

  console.log(`Scanning ${recipes.length} recipes with both components and ingredients...`);

  let recipesChanged = 0;
  let ingredientsChanged = 0;
  const changeLog = [];

  for (const recipe of recipes) {
    let changedThisRecipe = false;

    for (const ingredient of recipe.ingredients) {
      const match = recipe.components.find(
        (c) => c.label && c.label.trim().toLowerCase() === (ingredient.name || '').trim().toLowerCase()
      );
      if (!match) continue;
      if (ingredient.quantity === match.quantity && ingredient.unit === match.unit) continue;

      changeLog.push({
        recipe: recipe.name,
        ingredient: ingredient.name,
        from: `${ingredient.quantity}${ingredient.unit}`,
        to: `${match.quantity}${match.unit}`,
      });
      ingredient.quantity = match.quantity;
      ingredient.unit = match.unit;
      ingredientsChanged++;
      changedThisRecipe = true;
    }

    if (changedThisRecipe) {
      recipesChanged++;
      if (EXECUTE) await recipe.save();
    }
  }

  console.log('\n=== CHANGES ===');
  console.table(changeLog);
  console.log(`\n${recipesChanged} recipe(s), ${ingredientsChanged} ingredient(s) ${EXECUTE ? 'updated' : 'would be updated'}.`);

  if (!EXECUTE) {
    console.log('\nThis was a dry run - nothing written. Re-run with --execute to actually apply.');
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('Sync failed:', err);
  process.exit(1);
});
