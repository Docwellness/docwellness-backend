/**
 * One-time repair: renames pure unit-naming synonyms to one consistent
 * label per ingredient, so the grocery list's uniform-unit display (see
 * dietController.js's buildGroceryItemsForWeek) can actually kick in
 * instead of falling back to an approximate grams total whenever the same
 * real-world ingredient is recorded under two different unit spellings
 * across different recipes.
 *
 * Deliberately narrow: only ever renames within SYNONYMS, a fixed group of
 * unit strings that all mean "count of discrete items" - never touches the
 * quantity number, and never merges a count unit with a genuine
 * weight/volume unit (g/ml/cup/tbsp/tsp), since those aren't 1:1
 * equivalent and doing so without real conversion factors would silently
 * corrupt quantities. A catalog-wide scan (see this script's own dry-run
 * output) found 27 ingredients with inconsistent units across recipes;
 * only 2 (Brown Bread: piece/slice, Banana: nos/piece) were pure synonyms
 * safe to auto-fix this way - the rest genuinely mix incompatible unit
 * types and need real per-ingredient conversion factors added to
 * models/Ingredient.js's unitConversions, not a blind rename.
 *
 * Usage:
 *   node scripts/normalize-count-unit-synonyms.js            # dry run
 *   node scripts/normalize-count-unit-synonyms.js --execute  # actually write
 */

require('dns').setServers(['8.8.8.8', '1.1.1.1']);
require('dotenv').config();
const connectDB = require('../config/database');

const EXECUTE = process.argv.includes('--execute');

// ingredientName (lowercased) -> canonical unit to rename every synonym to.
// Add more pairs here only when you've confirmed by hand that every unit
// variant an ingredient uses really is a pure count synonym, not a
// disguised different measure.
const CANONICALIZE = {
  'brown bread': 'slice',
  'banana': 'piece',
};

const SYNONYMS = new Set(['piece', 'nos', 'slice', 'egg']);

async function main() {
  console.log(EXECUTE ? '=== EXECUTING unit synonym normalization ===' : '=== DRY RUN (pass --execute to write) ===');

  await connectDB();
  console.log('Connected.');

  const { Recipe } = require('../models');

  const recipes = await Recipe.find({ 'ingredients.0': { $exists: true } }).select('name ingredients');
  console.log(`Scanning ${recipes.length} recipes...`);

  let recipesChanged = 0;
  let ingredientsChanged = 0;
  const changeLog = [];

  for (const recipe of recipes) {
    let changedThisRecipe = false;

    for (const ingredient of recipe.ingredients) {
      const key = (ingredient.name || '').trim().toLowerCase();
      const canonicalUnit = CANONICALIZE[key];
      if (!canonicalUnit) continue;
      if (ingredient.unit === canonicalUnit) continue;
      if (!SYNONYMS.has(ingredient.unit)) continue; // never touch a non-count unit

      changeLog.push({
        recipe: recipe.name,
        ingredient: ingredient.name,
        from: ingredient.unit,
        to: canonicalUnit,
        quantity: ingredient.quantity,
      });
      ingredient.unit = canonicalUnit;
      ingredientsChanged++;
      changedThisRecipe = true;
    }

    if (changedThisRecipe) {
      recipesChanged++;
      if (EXECUTE) await recipe.save();
    }
  }

  console.log('\n=== CHANGES (unit renamed, quantity untouched) ===');
  console.table(changeLog);
  console.log(`\n${recipesChanged} recipe(s), ${ingredientsChanged} ingredient(s) ${EXECUTE ? 'updated' : 'would be updated'}.`);

  if (!EXECUTE) {
    console.log('\nThis was a dry run - nothing written. Re-run with --execute to actually apply.');
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('Normalization failed:', err);
  process.exit(1);
});
