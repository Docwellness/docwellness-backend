/**
 * READ-ONLY diagnostic: dumps the full current state of the 4 recalibrated
 * flatbread recipes (Chapati/Jowar Bhakri/Bajra Bhakri/Methi Thepla) - the
 * master Recipe's own ingredients/nutrition, EVERY RecipeVersion's
 * ingredients/nutritionPerServing, and every PlanItem referencing any of
 * them (with its DietPlan status). Never writes anything.
 *
 * Exists to get precise visibility after normalize-flatbread-portion-sizes.js
 * was run more than once on prod (not idempotent - each run re-applies its
 * ratio to whatever's currently stored, so a second run halves an already-
 * halved recipe) interleaved with reset-flatbread-planitems-to-v1.js
 * repointing PlanItems to V1 - syncV1FromRecipe's freeze semantics mean a
 * Recipe save AFTER a PlanItem already references V1 creates a NEW version
 * instead of updating V1 in place, so the actual current state needs to be
 * read directly rather than reconstructed from script output logs.
 *
 * Usage:
 *   node scripts/diagnose-flatbread-state.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/database');

const RECIPE_NAMES = ['Chapati', 'Jowar Bhakri', 'Bajra Bhakri', 'Methi Thepla'];

async function main() {
  console.log('Connecting to MongoDB...');
  await connectDB();
  console.log('Connected.\n');

  try {
    const { Recipe, RecipeVersion, PlanItem, MealSlotPlan, DayPlan, DietPlan } = require('../models');

    for (const name of RECIPE_NAMES) {
      const recipe = await Recipe.findOne({ name });
      console.log('='.repeat(60));
      console.log(name, '- Recipe _id:', recipe?._id);
      if (!recipe) {
        console.log('  NOT FOUND\n');
        continue;
      }
      console.log('  Recipe.nutrition:', JSON.stringify(recipe.nutrition));
      console.log('  Recipe.ingredients:');
      (recipe.ingredients || []).forEach((i) => console.log(`    - ${i.name}: ${i.quantity}${i.unit}`));

      const versions = await RecipeVersion.find({ parentRecipeId: recipe._id }).sort({ versionNumber: 1 });
      console.log(`  RecipeVersions (${versions.length}):`);
      for (const v of versions) {
        console.log(`    V${v.versionNumber} (${v._id}) nutritionPerServing: ${JSON.stringify(v.nutritionPerServing)}`);
      }

      const versionIds = versions.map((v) => v._id);
      const planItems = await PlanItem.find({ recipeVersionId: { $in: versionIds } });
      console.log(`  PlanItems referencing any version (${planItems.length}):`);
      for (const item of planItems) {
        const version = versions.find((v) => String(v._id) === String(item.recipeVersionId));
        const mealSlot = await MealSlotPlan.findById(item.mealSlotId);
        const dayPlan = mealSlot ? await DayPlan.findById(mealSlot.dayPlanId) : null;
        const dietPlan = dayPlan ? await DietPlan.findById(dayPlan.dietPlanId) : null;
        console.log(
          `    PlanItem ${item._id} -> V${version?.versionNumber ?? '?'} | calculatedNutrition: ${JSON.stringify(item.calculatedNutrition)} | DietPlan ${dietPlan?._id} status=${dietPlan?.status} patient=${dietPlan?.patientId}`
        );
      }
      console.log('');
    }
  } finally {
    await mongoose.disconnect();
    console.log('Disconnected from MongoDB.');
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
