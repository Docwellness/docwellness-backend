/**
 * Finishes what the flatbread-recalibration incident left half-done: gets
 * the corrected data back onto V1 itself (not sitting on a fresh tail
 * version - V54/V41/V11/V8 for the 4 recipes) and DELETES every other
 * version, so each of Chapati/Jowar Bhakri/Bajra Bhakri/Methi Thepla goes
 * back to having exactly one RecipeVersion again - by explicit dietician
 * request (this is the follow-through on "discard all these versions...
 * we have recalibrated V1 for all", asked before the double-scaling
 * incident and its cleanup made the version chains even longer).
 *
 * Directly overwrites V1's ingredients/nutritionPerServing/components via
 * a raw update - DELIBERATELY bypasses syncV1FromRecipe's freeze
 * semantics (which would otherwise refuse to touch V1 in place once a
 * PlanItem references it, and create yet another new version instead).
 * That freeze exists to protect prescribed patient plans from silent
 * rewrites; this script overrides it on purpose, same reasoning as
 * scripts/fix-flatbread-recipes-and-test-planitems.js and
 * reset-flatbread-planitems-to-v1.js before it - there is no correct data
 * anywhere in these chains except what this script writes, so there is
 * nothing worth preserving by leaving V1 alone.
 *
 * Steps per recipe:
 *   1. Repoint every PlanItem currently referencing ANY non-V1 version to
 *      V1's _id (with the corrected calculatedNutrition).
 *   2. Overwrite V1's ingredients/nutritionPerServing/components in place.
 *   3. Delete every RecipeVersion for this recipe except V1.
 *   4. Re-affirm the master Recipe's own ingredients/nutrition match (belt
 *      and suspenders - they should already be correct from the prior fix,
 *      this just guarantees it regardless of what happened in between).
 *
 * Same TARGET_INGREDIENTS as fix-flatbread-recipes-and-test-planitems.js -
 * see that script's header comment for the reference weights. `role` is
 * read from the master Recipe's own ingredients (already correctly
 * 'core'/'sub' from the earlier recipe-core-ingredient-scaling backfill),
 * not hardcoded here, so it can never drift from the master document.
 *
 * Usage:
 *   node scripts/consolidate-flatbread-versions-to-v1.js            # dry run
 *   node scripts/consolidate-flatbread-versions-to-v1.js --execute   # write
 */
require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/database');

const EXECUTE = process.argv.includes('--execute');

const TARGET_INGREDIENTS = {
  Chapati: [
    { name: 'Whole Wheat Flour', quantity: 40, unit: 'g' },
    { name: 'Water', quantity: 24, unit: 'ml' },
    { name: 'Salt', quantity: 0.4, unit: 'g' },
    { name: 'Ghee', quantity: 2, unit: 'g' },
  ],
  'Jowar Bhakri': [
    { name: 'Jowar Flour', quantity: 50, unit: 'g' },
    { name: 'Water', quantity: 50, unit: 'ml' },
    { name: 'Salt', quantity: 0.5, unit: 'tsp' },
  ],
  'Bajra Bhakri': [
    { name: 'Bajra (Pearl Millet) Flour', quantity: 50, unit: 'g' },
    { name: 'Water', quantity: 50, unit: 'ml' },
    { name: 'Salt', quantity: 0.5, unit: 'g' },
  ],
  'Methi Thepla': [
    { name: 'Whole Wheat Flour', quantity: 40, unit: 'g' },
    { name: 'Fenugreek Leaves', quantity: 20, unit: 'g' },
    { name: 'Yogurt', quantity: 12, unit: 'g' },
    { name: 'Turmeric Powder', quantity: 0.2, unit: 'tsp' },
    { name: 'Red Chilli Powder', quantity: 0.2, unit: 'tsp' },
    { name: 'Cumin Seeds', quantity: 0.2, unit: 'tsp' },
    { name: 'Salt', quantity: 0.4, unit: 'tsp' },
    { name: 'Oil', quantity: 0.4, unit: 'tbsp' },
    { name: 'Water', quantity: 20, unit: 'ml' },
  ],
};

async function main() {
  console.log(EXECUTE ? '=== EXECUTING flatbread version consolidation to V1 ===' : '=== DRY RUN (pass --execute to write) ===');
  console.log('Connecting to MongoDB...');
  await connectDB();
  console.log('Connected.');

  try {
    const { Recipe, FoodItem, RecipeVersion, PlanItem } = require('../models');
    const { normalize } = require('../utils/ingredientLibrary');
    const { computeNutritionFromIngredients } = require('../services/recipeVersioningService');

    let totalRepointed = 0;
    let totalDeleted = 0;
    let totalFailed = 0;

    for (const [name, targetIngredients] of Object.entries(TARGET_INGREDIENTS)) {
      console.log(`\n"${name}":`);
      const recipe = await Recipe.findOne({ name });
      if (!recipe) {
        console.log('  NOT FOUND - skipping');
        continue;
      }

      const v1 = await RecipeVersion.findOne({ parentRecipeId: recipe._id, versionNumber: 1 });
      if (!v1) {
        console.log('  NO V1 FOUND - skipping');
        continue;
      }

      const normalizedNames = targetIngredients.map((i) => normalize(i.name));
      const foodItems = await FoodItem.find({ normalizedName: { $in: normalizedNames } });
      const foodItemsByNormalizedName = new Map(foodItems.map((fi) => [fi.normalizedName, fi]));
      const foodItemsById = new Map(foodItems.map((fi) => [String(fi._id), fi]));
      const missing = targetIngredients.filter((i) => !foodItemsByNormalizedName.has(normalize(i.name)));
      if (missing.length > 0) {
        console.log(`  FAILED: no FoodItem match for ${JSON.stringify(missing.map((i) => i.name))} - skipping`);
        totalFailed++;
        continue;
      }

      const roleByNormalizedName = new Map(
        recipe.ingredients.map((ing) => [normalize(ing.name), ing.role === 'core' ? 'core' : 'sub'])
      );

      const correctedVersionIngredients = targetIngredients.map((i) => ({
        foodItemId: foodItemsByNormalizedName.get(normalize(i.name))._id,
        rawQuantity: i.quantity,
        unit: i.unit,
        preparation: null,
        role: roleByNormalizedName.get(normalize(i.name)) || 'sub',
      }));
      const { nutritionPerServing } = computeNutritionFromIngredients(correctedVersionIngredients, foodItemsById);
      const correctedComponents = (recipe.components || []).map((c) => ({ label: c.label, quantity: c.quantity, unit: c.unit }));

      console.log(`  V1 (${v1._id}) will become: ${JSON.stringify(nutritionPerServing)}, components: ${JSON.stringify(correctedComponents)}`);

      // Step 1: repoint every PlanItem on a non-V1 version to V1.
      const allVersions = await RecipeVersion.find({ parentRecipeId: recipe._id }).select('_id versionNumber');
      const nonV1Ids = allVersions.filter((v) => v.versionNumber !== 1).map((v) => v._id);
      const planItems = await PlanItem.find({ recipeVersionId: { $in: nonV1Ids } });
      console.log(`  ${allVersions.length} total version(s), ${nonV1Ids.length} non-V1, ${planItems.length} PlanItem(s) to repoint to V1`);

      if (EXECUTE) {
        for (const item of planItems) {
          try {
            item.recipeVersionId = v1._id;
            item.calculatedNutrition = {
              calories: nutritionPerServing.calories,
              protein: nutritionPerServing.protein,
              carbs: nutritionPerServing.carbs,
              fats: nutritionPerServing.fats,
              fiber: nutritionPerServing.fiber,
            };
            await item.save();
            totalRepointed++;
          } catch (err) {
            console.error(`    FAILED to repoint PlanItem ${item._id}: ${err.message}`);
            totalFailed++;
          }
        }

        // Step 2: overwrite V1 directly (bypasses freeze semantics on purpose).
        await RecipeVersion.updateOne(
          { _id: v1._id },
          {
            $set: {
              ingredients: correctedVersionIngredients,
              nutritionPerServing,
              components: correctedComponents,
              hasUnresolvedIngredients: false,
              unresolvedIngredientNames: [],
            },
          }
        );

        // Step 3: delete every other version.
        const deleteResult = await RecipeVersion.deleteMany({ parentRecipeId: recipe._id, versionNumber: { $ne: 1 } });
        totalDeleted += deleteResult.deletedCount;
        console.log(`  V1 overwritten, ${deleteResult.deletedCount} other version(s) deleted.`);

        // Step 4: re-affirm the master Recipe's own ingredients/nutrition.
        for (const target of targetIngredients) {
          const existing = recipe.ingredients.find((ing) => normalize(ing.name) === normalize(target.name));
          if (existing) {
            existing.quantity = target.quantity;
            existing.unit = target.unit;
          }
        }
        recipe.markModified('ingredients');
        recipe.nutrition = nutritionPerServing;
        // Bypass the post-save hook's syncV1FromRecipe call for this save -
        // it would otherwise immediately create ANOTHER new version now
        // that V1 has been directly overwritten above (V1 is still
        // referenced by the just-repointed PlanItems). Use updateOne
        // instead of .save() to skip Mongoose middleware entirely.
        await Recipe.updateOne(
          { _id: recipe._id },
          { $set: { ingredients: recipe.ingredients, nutrition: recipe.nutrition } }
        );
      }
    }

    console.log(
      `\n=== ${EXECUTE ? 'DONE' : 'DRY RUN DONE'} === planItemsRepointed=${totalRepointed} versionsDeleted=${totalDeleted} failed=${totalFailed}`
    );
  } finally {
    await mongoose.disconnect();
    console.log('Disconnected from MongoDB.');
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
