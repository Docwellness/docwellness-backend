/**
 * Repoints every PlanItem still referencing a stale (pre-recalibration)
 * RecipeVersion of Chapati/Jowar Bhakri/Bajra Bhakri/Methi Thepla back to
 * that recipe's current V1 - discarding whatever chain of Refine-step/
 * auto-balance custom versions (V2, V3, ... V48, etc.) it had accumulated,
 * all of which inherited the oversized pre-fix 100g-flour "1 piece"
 * baseline that scripts/normalize-flatbread-portion-sizes.js corrected.
 *
 * ** DELIBERATE EXCEPTION TO THIS CODEBASE'S OWN IMMUTABILITY RULE **
 * Every other script/comment in this repo protects the opposite
 * invariant - "a PlanItem already referencing a specific RecipeVersion._id
 * continues to resolve to the same RecipeVersion document, unchanged"
 * (recipe-database spec, "Fix does not affect already-published plans").
 * That rule exists so an ordinary recipe edit never silently changes food
 * a real patient has already been prescribed. This script intentionally
 * overrides that rule, for these 4 recipes only, by explicit dietician
 * request (the corrected V1 is the fix, and every existing version chain
 * for these 4 was built on the broken baseline - there is no "correct"
 * data anywhere in those chains to preserve). This includes PlanItems
 * belonging to Active/Finalized/Completed DietPlans, not just Draft ones -
 * a real, already-prescribed patient's portion for these 4 dishes WILL
 * change size as a result. That's the intended outcome, not a side effect
 * to work around.
 *
 * Consequence worth knowing: repointing straight to V1 also discards any
 * per-patient calorie-target personalization that had been layered onto
 * that specific chain via Refine/auto-balance (e.g. a weight-loss ratio) -
 * this resets the portion to the recipe's generic 1x V1 serving, not a
 * personalized-but-correctly-calibrated one. A dietician who wants this
 * patient's plan re-personalized after the reset should re-run Auto
 * Adjust/Refine for that day/week afterward; this script only fixes the
 * baseline it scales from.
 *
 * NOT a MealLog/history rewrite - MealLog references the master Recipe,
 * never a specific RecipeVersion, so a patient's already-logged meal
 * history is untouched by this (verified against models/MealLog.js before
 * writing this script).
 *
 * Only ever updates PlanItem.recipeVersionId + calculatedNutrition (the
 * cached-at-assignment-time nutrition, per PlanItem.js's own doc comment)
 * - never touches the Recipe/RecipeVersion documents themselves (already
 * fixed by normalize-flatbread-portion-sizes.js) or any other PlanItem
 * field (locked, isLinkedComponent, etc. are left exactly as they were).
 *
 * Connects via connectDB() (config/database.js), not a raw
 * mongoose.connect() - required for prod's self-hosted Mongo's custom TLS
 * CA.
 *
 * Idempotent: re-running only ever finds PlanItems still pointing at a
 * non-V1 version of these 4 recipes - once repointed, a re-run reports 0.
 *
 * Usage:
 *   node scripts/reset-flatbread-planitems-to-v1.js              # dry run
 *   node scripts/reset-flatbread-planitems-to-v1.js --execute     # write
 */
require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/database');

const EXECUTE = process.argv.includes('--execute');

const RECIPE_NAMES = ['Chapati', 'Jowar Bhakri', 'Bajra Bhakri', 'Methi Thepla'];

async function main() {
  console.log(EXECUTE ? '=== EXECUTING flatbread PlanItem reset-to-V1 ===' : '=== DRY RUN (pass --execute to write) ===');
  console.log('Connecting to MongoDB...');
  await connectDB();
  console.log('Connected.');

  try {
    const { Recipe, RecipeVersion, PlanItem, MealSlotPlan, DayPlan, DietPlan } = require('../models');

    const recipes = await Recipe.find({ name: { $in: RECIPE_NAMES } });
    console.log(`Found ${recipes.length}/${RECIPE_NAMES.length} named recipes.\n`);
    RECIPE_NAMES.filter((n) => !recipes.some((r) => r.name === n)).forEach((n) => console.log(`NOT FOUND (skipping): "${n}"`));

    let totalUpdated = 0;
    let totalFailed = 0;

    for (const recipe of recipes) {
      const v1 = await RecipeVersion.findOne({ parentRecipeId: recipe._id, versionNumber: 1 });
      if (!v1) {
        console.log(`  SKIP "${recipe.name}": no V1 RecipeVersion found\n`);
        continue;
      }

      const staleVersions = await RecipeVersion.find({
        parentRecipeId: recipe._id,
        versionNumber: { $ne: 1 },
      }).select('_id versionNumber');
      const staleIds = staleVersions.map((v) => v._id);

      if (staleIds.length === 0) {
        console.log(`"${recipe.name}": no non-V1 versions exist, nothing to reset.\n`);
        continue;
      }

      const planItems = await PlanItem.find({ recipeVersionId: { $in: staleIds } });
      console.log(`"${recipe.name}": ${staleVersions.length} stale version(s) (V${staleVersions.map((v) => v.versionNumber).join(', V')}), ${planItems.length} PlanItem(s) referencing them.`);

      if (planItems.length === 0) {
        console.log('');
        continue;
      }

      // Report which DietPlan status each affected PlanItem belongs to, so
      // the log makes clear this does reach Active/Finalized plans, not
      // just Draft ones - visible before any write happens.
      const mealSlotIds = planItems.map((p) => p.mealSlotId);
      const mealSlots = await MealSlotPlan.find({ _id: { $in: mealSlotIds } }).select('_id dayPlanId');
      const mealSlotToDayPlan = new Map(mealSlots.map((m) => [String(m._id), String(m.dayPlanId)]));
      const dayPlans = await DayPlan.find({ _id: { $in: [...new Set(mealSlots.map((m) => m.dayPlanId))] } }).select('_id dietPlanId');
      const dayPlanToDietPlan = new Map(dayPlans.map((d) => [String(d._id), String(d.dietPlanId)]));
      const dietPlans = await DietPlan.find({ _id: { $in: [...new Set(dayPlans.map((d) => d.dietPlanId))] } }).select('_id status');
      const statusByDietPlanId = new Map(dietPlans.map((d) => [String(d._id), d.status]));
      const statusCounts = {};
      for (const item of planItems) {
        const dayPlanId = mealSlotToDayPlan.get(String(item.mealSlotId));
        const dietPlanId = dayPlanToDietPlan.get(dayPlanId);
        const status = statusByDietPlanId.get(dietPlanId) || 'UNKNOWN';
        statusCounts[status] = (statusCounts[status] || 0) + 1;
      }
      console.log(`  by DietPlan status: ${JSON.stringify(statusCounts)}`);
      console.log(`  -> repointing all to V1 (${v1._id}), calculatedNutrition -> ${JSON.stringify(v1.nutritionPerServing)}`);

      if (EXECUTE) {
        for (const item of planItems) {
          try {
            item.recipeVersionId = v1._id;
            item.calculatedNutrition = {
              calories: v1.nutritionPerServing?.calories ?? null,
              protein: v1.nutritionPerServing?.protein ?? null,
              carbs: v1.nutritionPerServing?.carbs ?? null,
              fats: v1.nutritionPerServing?.fats ?? null,
              fiber: v1.nutritionPerServing?.fiber ?? null,
            };
            await item.save();
            totalUpdated++;
          } catch (err) {
            console.error(`    FAILED to update PlanItem ${item._id}: ${err.message}`);
            totalFailed++;
          }
        }
        console.log('  done.\n');
      } else {
        console.log('');
      }
    }

    console.log(`\n=== ${EXECUTE ? 'DONE' : 'DRY RUN DONE'} === planItemsUpdated=${totalUpdated} failed=${totalFailed}`);
  } finally {
    await mongoose.disconnect();
    console.log('Disconnected from MongoDB.');
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
