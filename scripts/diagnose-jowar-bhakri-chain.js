/**
 * READ-ONLY: dumps Jowar Bhakri's RecipeVersion chain from V54 onward
 * (V54 is the corrected version scripts/fix-flatbread-recipes-and-test-
 * planitems.js just created) - full ingredients AND components for each,
 * plus which PlanItem(s) currently point at which version. Exists to
 * trace exactly where "components" (Makes on the plate) and "ingredients"
 * (the actual flour/water/salt weights) diverged after that fix - a
 * dietician-reported "½ piece" despite the flour barely having moved from
 * the corrected 50g baseline (49.6g) doesn't match createCustomVersion's
 * own math (both are meant to scale by the exact same
 * newCalories/originalCalories ratio per edit), so something in this
 * specific chain needs to be seen directly rather than guessed at. Never
 * writes anything.
 *
 * Usage:
 *   node scripts/diagnose-jowar-bhakri-chain.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/database');

async function main() {
  console.log('Connecting to MongoDB...');
  await connectDB();
  console.log('Connected.\n');

  try {
    const { Recipe, RecipeVersion, PlanItem } = require('../models');

    const recipe = await Recipe.findOne({ name: 'Jowar Bhakri' });
    console.log('Recipe _id:', recipe._id);

    const versions = await RecipeVersion.find({ parentRecipeId: recipe._id, versionNumber: { $gte: 54 } }).sort({ versionNumber: 1 });
    for (const v of versions) {
      console.log('='.repeat(60));
      console.log(`V${v.versionNumber} (${v._id})`);
      console.log('  nutritionPerServing:', JSON.stringify(v.nutritionPerServing));
      console.log('  ingredients:');
      v.ingredients.forEach((i) => console.log(`    - foodItemId=${i.foodItemId} rawQuantity=${i.rawQuantity} unit=${i.unit} role=${i.role}`));
      console.log('  components:', JSON.stringify(v.components));
      const referencingItems = await PlanItem.find({ recipeVersionId: v._id });
      console.log(`  referenced by ${referencingItems.length} PlanItem(s):`, referencingItems.map((p) => p._id.toString()));
    }
  } finally {
    await mongoose.disconnect();
    console.log('\nDisconnected from MongoDB.');
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
