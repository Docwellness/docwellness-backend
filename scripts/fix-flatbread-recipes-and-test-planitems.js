/**
 * ONE-SHOT correction for the flatbread portion-size incident:
 * normalize-flatbread-portion-sizes.js was run more than once on prod (it
 * was ratio-based - "100g -> 40g" - not idempotent, so a second run
 * re-applied the same ratio to the already-corrected 40g, landing on 16g).
 * Interleaved with reset-flatbread-planitems-to-v1.js repointing PlanItems
 * to "V1" in between, and syncV1FromRecipe's freeze semantics (a Recipe
 * save after a PlanItem already references a version creates a NEW
 * version instead of updating it in place), Chapati/Jowar Bhakri/Bajra
 * Bhakri/Methi Thepla each ended up with a long, inconsistent chain of
 * RecipeVersions (10/53/40/7 respectively) and their master Recipe
 * documents landed on incorrect double-halved values.
 *
 * scripts/diagnose-flatbread-state.js's output confirmed every single
 * PlanItem referencing any version of these 4 recipes belongs to exactly
 * ONE Draft DietPlan (the [TEST] patient's plan) - no real, already-
 * prescribed patient plan is affected. This script is scoped to exactly
 * that DietPlan, not a blanket sweep.
 *
 * STEP A: sets each recipe's ingredients to the correct ABSOLUTE target
 * quantities (not a ratio multiplied against whatever's currently
 * stored) - genuinely idempotent this time; re-running lands on the same
 * values no matter how many times it's run or what state it starts from.
 * Recomputes nutrition from real FoodItem.nutritionPer100g data (same
 * computeNutritionFromIngredients used everywhere else in this repo).
 * Explicitly captures the RecipeVersion document syncV1FromRecipe returns
 * (it's frozen - referenced by a PlanItem - so this creates a fresh
 * correct version rather than mutating V1 in place; capturing the return
 * value directly means never having to guess which version number it
 * became).
 *
 * STEP B: repoints every PlanItem in DietPlan TARGET_DIET_PLAN_ID that
 * references ANY existing version of these 4 recipes (not just "V1" -
 * every stale version in the chain) to the fresh correct version from
 * Step A.
 *
 * Target absolute values (same reasoning as
 * normalize-flatbread-portion-sizes.js's original header comment - a
 * realistic single roti/bhakri/thepla is ~40-50g flour):
 *   Chapati: Whole Wheat Flour 40g, Water 24ml, Salt 0.4g, Ghee 2g
 *   Jowar Bhakri: Jowar Flour 50g, Water 50ml, Salt 0.5tsp
 *   Bajra Bhakri: Bajra (Pearl Millet) Flour 50g, Water 50ml, Salt 0.5g
 *   Methi Thepla: Whole Wheat Flour 40g, Fenugreek Leaves 20g, Yogurt 12g,
 *     Turmeric Powder 0.2tsp, Red Chilli Powder 0.2tsp, Cumin Seeds 0.2tsp,
 *     Salt 0.4tsp, Oil 0.4tbsp, Water 20ml
 *
 * Usage:
 *   node scripts/fix-flatbread-recipes-and-test-planitems.js            # dry run
 *   node scripts/fix-flatbread-recipes-and-test-planitems.js --execute   # write
 */
require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/database');

const EXECUTE = process.argv.includes('--execute');

const TARGET_DIET_PLAN_ID = '6a9035211aa6284ccd1b34a1';

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
  console.log(EXECUTE ? '=== EXECUTING flatbread recipe + test-plan-item fix ===' : '=== DRY RUN (pass --execute to write) ===');
  console.log('Connecting to MongoDB...');
  await connectDB();
  console.log('Connected.');

  try {
    const { Recipe, FoodItem, RecipeVersion, PlanItem, MealSlotPlan, DayPlan } = require('../models');
    const { normalize } = require('../utils/ingredientLibrary');
    const { syncV1FromRecipe, computeNutritionFromIngredients } = require('../services/recipeVersioningService');

    // --- STEP A: fix each recipe to the correct absolute values ---
    const correctedVersionByRecipeId = new Map();

    for (const [name, targetIngredients] of Object.entries(TARGET_INGREDIENTS)) {
      const recipe = await Recipe.findOne({ name });
      if (!recipe) {
        console.log(`NOT FOUND (skipping): "${name}"`);
        continue;
      }

      const normalizedNames = targetIngredients.map((i) => normalize(i.name));
      const foodItems = await FoodItem.find({ normalizedName: { $in: normalizedNames } });
      const foodItemsByNormalizedName = new Map(foodItems.map((fi) => [fi.normalizedName, fi]));
      const foodItemsById = new Map(foodItems.map((fi) => [String(fi._id), fi]));

      const missing = targetIngredients.filter((i) => !foodItemsByNormalizedName.has(normalize(i.name)));
      if (missing.length > 0) {
        console.error(`  FAILED "${name}": no FoodItem match for ${JSON.stringify(missing.map((i) => i.name))} - skipping`);
        continue;
      }

      const versionShaped = targetIngredients.map((i) => ({
        foodItemId: foodItemsByNormalizedName.get(normalize(i.name))._id,
        rawQuantity: i.quantity,
        unit: i.unit,
      }));
      const { nutritionPerServing } = computeNutritionFromIngredients(versionShaped, foodItemsById);

      console.log(`"${name}":`);
      targetIngredients.forEach((i) => console.log(`  ${i.name}: ${i.quantity}${i.unit}`));
      console.log(`  nutrition -> ${JSON.stringify(nutritionPerServing)}`);
      console.log(`  current Recipe.nutrition: ${JSON.stringify(recipe.nutrition)}`);

      if (EXECUTE) {
        // Rebuild ingredients array by name-matching against the recipe's
        // OWN existing ingredient subdocuments so any fields other than
        // quantity (category, priceLevel, description, etc.) are preserved
        // untouched - only quantity/unit are corrected.
        for (const target of targetIngredients) {
          const existing = recipe.ingredients.find((ing) => normalize(ing.name) === normalize(target.name));
          if (existing) {
            existing.quantity = target.quantity;
            existing.unit = target.unit;
          }
        }
        recipe.markModified('ingredients');
        recipe.nutrition = nutritionPerServing;
        await recipe.save();
        const newVersion = await syncV1FromRecipe(recipe);
        if (!newVersion) {
          console.error(`  FAILED: syncV1FromRecipe returned null for "${name}"`);
          continue;
        }
        correctedVersionByRecipeId.set(String(recipe._id), newVersion);
        console.log(`  saved. New RecipeVersion: V${newVersion.versionNumber} (${newVersion._id})\n`);
      } else {
        console.log('');
      }
    }

    if (!EXECUTE) {
      console.log('\n(dry run - Step B PlanItem repointing preview skipped; run --execute to see + apply it)');
      return;
    }

    // --- STEP B: repoint every PlanItem in the one affected DietPlan ---
    console.log('\n--- STEP B: repointing PlanItems in DietPlan', TARGET_DIET_PLAN_ID, '---');
    const dayPlans = await DayPlan.find({ dietPlanId: TARGET_DIET_PLAN_ID }).select('_id');
    const mealSlots = await MealSlotPlan.find({ dayPlanId: { $in: dayPlans.map((d) => d._id) } }).select('_id');
    const planItems = await PlanItem.find({ mealSlotId: { $in: mealSlots.map((m) => m._id) } });

    const recipeIdByVersionId = new Map();
    for (const [recipeId, version] of correctedVersionByRecipeId) {
      const allVersionsForRecipe = await RecipeVersion.find({ parentRecipeId: recipeId }).select('_id');
      allVersionsForRecipe.forEach((v) => recipeIdByVersionId.set(String(v._id), recipeId));
    }

    let repointed = 0;
    let failed = 0;
    for (const item of planItems) {
      const recipeId = recipeIdByVersionId.get(String(item.recipeVersionId));
      if (!recipeId) continue; // not one of the 4 recalibrated recipes
      const newVersion = correctedVersionByRecipeId.get(recipeId);
      if (!newVersion || String(item.recipeVersionId) === String(newVersion._id)) continue; // already correct

      console.log(`  PlanItem ${item._id}: V?(${item.recipeVersionId}) -> V${newVersion.versionNumber}(${newVersion._id})`);
      try {
        item.recipeVersionId = newVersion._id;
        item.calculatedNutrition = {
          calories: newVersion.nutritionPerServing?.calories ?? null,
          protein: newVersion.nutritionPerServing?.protein ?? null,
          carbs: newVersion.nutritionPerServing?.carbs ?? null,
          fats: newVersion.nutritionPerServing?.fats ?? null,
          fiber: newVersion.nutritionPerServing?.fiber ?? null,
        };
        await item.save();
        repointed++;
      } catch (err) {
        console.error(`    FAILED: ${err.message}`);
        failed++;
      }
    }

    console.log(`\n=== DONE === recipesFixed=${correctedVersionByRecipeId.size} planItemsRepointed=${repointed} failed=${failed}`);
  } finally {
    await mongoose.disconnect();
    console.log('Disconnected from MongoDB.');
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
