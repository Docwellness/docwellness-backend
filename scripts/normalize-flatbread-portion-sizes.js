/**
 * Recalibrates a handful of plain flatbread recipes (Chapati, Jowar Bhakri,
 * Bajra Bhakri, Methi Thepla) whose "1 piece" component was backed by an
 * unrealistically large 100g of flour - roughly 2.5x a real single medium
 * roti/bhakri/thepla (~40-50g flour is the standard reference; 100g is
 * closer to 2-3 pieces' worth). This is what produced weird auto-scaled
 * fractions like "0.52 piece" for a weight-loss patient's Refine step
 * (services/ingredientAutoBalanceService.js scales every ingredient
 * proportionally toward a calorie target, and createCustomVersion scales
 * `components` by the same overall ratio - an oversized base reference
 * means an ordinary calorie target lands mid-piece instead of near a whole
 * one). Found via investigating a dietician-reported bug: search for all
 * chapati/bhakri/paratha/chilla recipes turned up 18 matches total; most
 * (all the chillas, all the stuffed parathas) already have a realistic
 * per-piece weight and are untouched here - see the header comment on
 * TARGET_FLOUR_RATIO below for why only these 4 needed fixing.
 *
 * Every ingredient in a fixed recipe is scaled by the SAME ratio (not just
 * the flour) so the dish's own internal proportions (water:flour,
 * ghee:flour, spice levels) stay identical to before - this only shrinks
 * the recipe to a real single serving, it doesn't re-formulate it.
 * `components` itself is left untouched (still `{quantity:1,unit:'piece'}`
 * for every one of these) - only the ingredient weights backing that one
 * piece change, so the display is unaffected here; what changes is how
 * accurately Refine-step scaling behaves against a real base weight.
 *
 * `nutrition` is recomputed from scratch afterward using the SAME
 * FoodItem.nutritionPer100g-based computation the rest of the system
 * trusts (resolveGramsForIngredient/computeNutritionFromIngredients from
 * services/recipeVersioningService.js) - not hand-typed, not re-derived
 * proportionally from the old (already-inconsistent - see below) nutrition
 * figure. Investigating this surfaced that these 4 recipes' stored
 * `nutrition` was ALREADY inconsistent with their 100g-flour ingredient
 * list (e.g. Chapati's stored 104 kcal implies roughly 30g of flour, not
 * 100g - closer to what a real single piece should be, while the
 * ingredients said otherwise) - recomputing properly from real FoodItem
 * data resolves that mismatch rather than compounding it.
 *
 * Saves through the master Recipe document and explicitly awaits
 * syncV1FromRecipe after each save, same reasoning as every other backfill
 * script in this repo.
 *
 * Connects via connectDB() (config/database.js), not a raw
 * mongoose.connect() - required for prod's self-hosted Mongo's custom TLS
 * CA.
 *
 * Idempotent-ish: re-running recomputes from the CURRENT (already-scaled,
 * after a first --execute) ingredient quantities against the same target
 * ratio of 1 (a no-op second pass) - safe to re-run, but not idempotent in
 * the strict "skips if already done" sense other backfills use, since
 * there's no clean flag distinguishing "already recalibrated" from
 * "genuinely still 100g/piece for some other legitimate reason". Meant to
 * be run once.
 *
 * Usage:
 *   node scripts/normalize-flatbread-portion-sizes.js            # dry run
 *   node scripts/normalize-flatbread-portion-sizes.js --execute   # write
 */
require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/database');

const EXECUTE = process.argv.includes('--execute');

// Target ratio = (realistic single-piece flour weight) / (currently stored
// flour weight, 100g for every one of these). Reference weights: a plain
// wheat chapati/roti is commonly ~35-40g flour; jowar/bajra bhakri are
// typically a bit thicker/larger, ~45-50g; methi thepla is thin and
// roti-sized despite the added methi/spices, ~35-40g. Every OTHER
// ingredient in the recipe (water, ghee, salt, spices) is scaled by this
// same ratio, preserving the dish's own proportions.
const TARGET_FLOUR_RATIO = {
  Chapati: 0.4, // 100g -> 40g
  'Jowar Bhakri': 0.5, // 100g -> 50g
  'Bajra Bhakri': 0.5, // 100g -> 50g
  'Methi Thepla': 0.4, // 100g -> 40g
};

async function main() {
  console.log(EXECUTE ? '=== EXECUTING flatbread portion-size normalization ===' : '=== DRY RUN (pass --execute to write) ===');
  console.log('Connecting to MongoDB...');
  await connectDB();
  console.log('Connected.');

  try {
    const { Recipe, FoodItem } = require('../models');
    const { normalize } = require('../utils/ingredientLibrary');
    const { syncV1FromRecipe, computeNutritionFromIngredients } = require('../services/recipeVersioningService');

    const names = Object.keys(TARGET_FLOUR_RATIO);
    const recipes = await Recipe.find({ name: { $in: names } });
    console.log(`Found ${recipes.length}/${names.length} named recipes.\n`);
    names.filter((n) => !recipes.some((r) => r.name === n)).forEach((n) => console.log(`NOT FOUND (skipping): "${n}"`));

    let updated = 0;
    let failed = 0;

    for (const recipe of recipes) {
      const ratio = TARGET_FLOUR_RATIO[recipe.name];
      const scaledIngredients = recipe.ingredients.map((ing) => ({
        ...ing.toObject(),
        quantity: Math.round(ing.quantity * ratio * 100) / 100,
      }));

      // Resolve each scaled ingredient to its FoodItem (by normalized name,
      // same lookup style syncV1FromRecipe uses) so nutrition can be
      // recomputed from real per-100g data rather than proportionally
      // carried forward from a figure already shown to be inconsistent.
      const normalizedNames = scaledIngredients.map((ing) => normalize(ing.name));
      const foodItems = await FoodItem.find({ normalizedName: { $in: normalizedNames } });
      const foodItemsByNormalizedName = new Map(foodItems.map((fi) => [fi.normalizedName, fi]));
      const foodItemsById = new Map(foodItems.map((fi) => [String(fi._id), fi]));

      const unresolvedNames = scaledIngredients
        .filter((ing) => !foodItemsByNormalizedName.has(normalize(ing.name)))
        .map((ing) => ing.name);
      if (unresolvedNames.length > 0) {
        console.error(`  FAILED "${recipe.name}": no FoodItem match for ${JSON.stringify(unresolvedNames)} - skipping\n`);
        failed++;
        continue;
      }

      const versionShapedIngredients = scaledIngredients.map((ing) => ({
        foodItemId: foodItemsByNormalizedName.get(normalize(ing.name))._id,
        rawQuantity: ing.quantity,
        unit: ing.unit,
      }));
      const { nutritionPerServing, hasUnresolvedIngredients, unresolvedIngredientNames } = computeNutritionFromIngredients(
        versionShapedIngredients,
        foodItemsById
      );
      if (hasUnresolvedIngredients) {
        console.error(`  FAILED "${recipe.name}": unit conversion unresolved for ${JSON.stringify(unresolvedIngredientNames)} - skipping\n`);
        failed++;
        continue;
      }

      console.log(`"${recipe.name}" (ratio ${ratio}):`);
      scaledIngredients.forEach((ing, i) => console.log(`  ${recipe.ingredients[i].name}: ${recipe.ingredients[i].quantity}${recipe.ingredients[i].unit} -> ${ing.quantity}${ing.unit}`));
      console.log(`  nutrition: ${JSON.stringify(recipe.nutrition)} -> ${JSON.stringify(nutritionPerServing)}`);

      if (EXECUTE) {
        try {
          scaledIngredients.forEach((ing, i) => {
            recipe.ingredients[i].quantity = ing.quantity;
          });
          recipe.markModified('ingredients');
          recipe.nutrition = nutritionPerServing;
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

    console.log(`\n=== ${EXECUTE ? 'DONE' : 'DRY RUN DONE'} === total=${recipes.length} updated=${updated} failed=${failed}`);
  } finally {
    await mongoose.disconnect();
    console.log('Disconnected from MongoDB.');
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
