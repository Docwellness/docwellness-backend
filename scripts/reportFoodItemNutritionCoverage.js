/**
 * Read-only report: per-dietician, what fraction of their active recipes
 * have ALL ingredients resolving to a FoodItem with a fully-populated
 * nutritionPer100g? This is the v4.0 plan's Phase 0 "prerequisite complete"
 * gate - services/menuGenerationService.js (Phase 3) should only be
 * flag-flipped on for a dietician once this crosses ~90% of their actively-
 * used recipe pool, per the plan's Phase 0c.
 *
 * Reads RecipeVersion (not Recipe.ingredients[] directly) since
 * hasUnresolvedIngredients is already computed there by
 * services/recipeVersioningService.js - this report is a rollup of that
 * flag, not a second independent resolution pass.
 *
 * Never writes anything.
 *
 * Usage:
 *   node scripts/reportFoodItemNutritionCoverage.js
 *   node scripts/reportFoodItemNutritionCoverage.js --json
 */

require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/database');

const JSON_OUTPUT = process.argv.includes('--json');

async function main() {
  console.log('Connecting to MongoDB...');
  const tlsCAFile = connectDB.resolveTlsCAFile();
  const connectOptions = tlsCAFile ? { tls: true, tlsCAFile } : {};
  await mongoose.connect(process.env.MONGODB_URI, connectOptions);
  console.log('Connected.');

  try {
    const { Recipe, RecipeVersion, User } = require('../models');

    const recipes = await Recipe.find({ category: { $ne: 'Supplements' }, status: { $ne: 'Archived' } }).select('dieticianId');
    const recipeIdsByDietician = new Map();
    for (const recipe of recipes) {
      const key = String(recipe.dieticianId);
      if (!recipeIdsByDietician.has(key)) recipeIdsByDietician.set(key, []);
      recipeIdsByDietician.get(key).push(recipe._id);
    }

    const allRecipeIds = recipes.map((r) => r._id);
    const v1Versions = await RecipeVersion.find({
      parentRecipeId: { $in: allRecipeIds },
      versionNumber: 1,
    }).select('parentRecipeId hasUnresolvedIngredients');
    const v1ByRecipeId = new Map(v1Versions.map((v) => [String(v.parentRecipeId), v]));

    const rows = [];
    for (const [dieticianId, recipeIds] of recipeIdsByDietician.entries()) {
      let covered = 0;
      let noV1Yet = 0;
      for (const recipeId of recipeIds) {
        const v1 = v1ByRecipeId.get(String(recipeId));
        if (!v1) {
          noV1Yet += 1;
        } else if (!v1.hasUnresolvedIngredients) {
          covered += 1;
        }
      }
      const total = recipeIds.length;
      rows.push({
        dieticianId,
        totalRecipes: total,
        coveredRecipes: covered,
        recipesWithNoV1Yet: noV1Yet,
        coveragePercent: total > 0 ? Math.round((covered / total) * 1000) / 10 : 0,
      });
    }

    rows.sort((a, b) => a.coveragePercent - b.coveragePercent);

    if (JSON_OUTPUT) {
      console.log(JSON.stringify(rows, null, 2));
      return;
    }

    const dieticians = await User.find({ _id: { $in: rows.map((r) => r.dieticianId) } }).select('email profile.fullName');
    const dieticianLabel = new Map(dieticians.map((d) => [String(d._id), d.profile?.fullName || d.email]));

    console.log('\n=== FoodItem nutrition coverage, per dietician ===');
    console.log('coverage%  covered/total  noV1Yet  dietician');
    for (const row of rows) {
      console.log(
        `${String(row.coveragePercent).padStart(8)}%  ${`${row.coveredRecipes}/${row.totalRecipes}`.padStart(13)}  ${String(row.recipesWithNoV1Yet).padStart(7)}  ${dieticianLabel.get(row.dieticianId) || row.dieticianId}`
      );
    }
    const readyCount = rows.filter((r) => r.coveragePercent >= 90).length;
    console.log(`\n${readyCount}/${rows.length} dietician(s) at or above the 90% coverage gate.`);
    console.log('Run scripts/backfill-recipe-versions.js first if "noV1Yet" is non-zero for any dietician above.');
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error('Report failed:', err);
  process.exit(1);
});
