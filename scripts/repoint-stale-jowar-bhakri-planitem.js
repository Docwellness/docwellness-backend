/**
 * Surgical one-off: repoints the ONE known PlanItem currently on Jowar
 * Bhakri's V55 (born from a Save that referenced a stale pre-fix baseline
 * - role flipped 'core'->'sub' and components dropped to 0.5 piece despite
 * ingredients barely changing, see the diagnose-jowar-bhakri-chain.js
 * conversation that found this) back to V54, the correct, already-fixed
 * version scripts/fix-flatbread-recipes-and-test-planitems.js created.
 *
 * Hardcoded to the exact PlanItem/version ids found via
 * diagnose-jowar-bhakri-chain.js's prod output - deliberately narrow, not
 * a general sweep, since this is a one-off staleness artifact (the Refine
 * screen was open across the backend fix landing), not a recurring data
 * problem.
 *
 * Usage:
 *   node scripts/repoint-stale-jowar-bhakri-planitem.js            # dry run
 *   node scripts/repoint-stale-jowar-bhakri-planitem.js --execute   # write
 */
require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/database');

const EXECUTE = process.argv.includes('--execute');
const PLAN_ITEM_ID = '6a9038e45a58fc0c7463e25b';
const CORRECT_VERSION_ID = '6a90386a142fe083d89544dc'; // Jowar Bhakri V54

async function main() {
  console.log(EXECUTE ? '=== EXECUTING repoint ===' : '=== DRY RUN (pass --execute to write) ===');
  console.log('Connecting to MongoDB...');
  await connectDB();
  console.log('Connected.');

  try {
    const { PlanItem, RecipeVersion } = require('../models');

    const item = await PlanItem.findById(PLAN_ITEM_ID);
    if (!item) {
      console.log(`PlanItem ${PLAN_ITEM_ID} not found - nothing to do.`);
      return;
    }
    const correctVersion = await RecipeVersion.findById(CORRECT_VERSION_ID);
    if (!correctVersion) {
      console.log(`RecipeVersion ${CORRECT_VERSION_ID} not found - aborting.`);
      return;
    }

    console.log(`PlanItem ${item._id}: currently -> ${item.recipeVersionId}`);
    console.log(`  will repoint to V${correctVersion.versionNumber} (${correctVersion._id})`);
    console.log(`  calculatedNutrition -> ${JSON.stringify(correctVersion.nutritionPerServing)}`);
    console.log(`  components -> ${JSON.stringify(correctVersion.components)}`);

    if (String(item.recipeVersionId) === String(correctVersion._id)) {
      console.log('Already correct - nothing to do.');
      return;
    }

    if (EXECUTE) {
      item.recipeVersionId = correctVersion._id;
      item.calculatedNutrition = {
        calories: correctVersion.nutritionPerServing?.calories ?? null,
        protein: correctVersion.nutritionPerServing?.protein ?? null,
        carbs: correctVersion.nutritionPerServing?.carbs ?? null,
        fats: correctVersion.nutritionPerServing?.fats ?? null,
        fiber: correctVersion.nutritionPerServing?.fiber ?? null,
      };
      await item.save();
      console.log('saved.');
    }

    console.log(`\n=== ${EXECUTE ? 'DONE' : 'DRY RUN DONE'} ===`);
  } finally {
    await mongoose.disconnect();
    console.log('Disconnected from MongoDB.');
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
