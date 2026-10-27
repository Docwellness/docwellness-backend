/**
 * Read-only FoodItem catalog export for openspec/changes/fill-recipe-micronutrients
 * (design.md Decision 8, stage 2; task 6.5). Meant to be run by the user in a
 * Coolify terminal against prod; the pasted output tells us which prod-only
 * ingredients still need researching before the migration is finalised.
 *
 * Makes no writes (find / aggregate / lean only), connects through
 * connectDB() (never a bare mongoose.connect), and prints no connection
 * string or .env value. connectDB() may touch indexes (not documents); confirm
 * SYNC_INDEXES_ON_BOOT is unset before a prod run, same as export-recipes-prod.js.
 *
 * Prints one JSON document to stdout: for each FoodItem its name,
 * normalizedName, dataSource, nutritionPer100g, and how many recipes use it
 * (RecipeVersion.ingredients[] count, plus a count of Recipe.ingredients[]
 * names matching normalizedName). Catalog data only: no patient, PlanItem,
 * user or dietician data is read.
 *
 * Usage (repo root):
 *   node scripts/export-fooditem-catalog-prod.js > fooditem-catalog.json
 * (the one-line `MongoDB Connected: <host>` message from connectDB() goes to
 * stdout too; strip it or paste the JSON part only.)
 */
require('dotenv').config({ quiet: true });
const mongoose = require('mongoose');
const connectDB = require('../config/database');
const { normalize } = require('../utils/ingredientLibrary');

async function main() {
  await connectDB();
  try {
    const FoodItem = require('../models/FoodItem');
    const RecipeVersion = require('../models/RecipeVersion');
    const Recipe = require('../models/Recipe');

    const foodItems = await FoodItem.find({}).select('name normalizedName dataSource nutritionPer100g').sort({ normalizedName: 1 }).lean();

    // Distinct recipes (by parentRecipeId) whose any version references the FoodItem.
    const versionUsage = await RecipeVersion.aggregate([
      { $unwind: '$ingredients' },
      { $group: { _id: { foodItemId: '$ingredients.foodItemId', recipeId: '$parentRecipeId' } } },
      { $group: { _id: '$_id.foodItemId', recipes: { $sum: 1 } } },
    ]);
    const versionUsageById = new Map(versionUsage.map((u) => [String(u._id), u.recipes]));

    // Recipes use free-text ingredient names, so count by normalized name.
    const recipeUsageByName = new Map();
    const recipes = await Recipe.find({}).select('ingredients.name').lean();
    for (const recipe of recipes) {
      const names = new Set((recipe.ingredients || []).map((i) => (i?.name ? normalize(i.name) : null)).filter(Boolean));
      names.forEach((n) => recipeUsageByName.set(n, (recipeUsageByName.get(n) || 0) + 1));
    }

    const items = foodItems.map((f) => ({
      name: f.name,
      normalizedName: f.normalizedName,
      dataSource: f.dataSource,
      nutritionPer100g: f.nutritionPer100g || null,
      recipesUsingViaVersions: versionUsageById.get(String(f._id)) || 0,
      recipesUsingViaIngredientName: recipeUsageByName.get(f.normalizedName) || 0,
    }));

    console.log(JSON.stringify({ generatedAt: new Date().toISOString(), totalFoodItems: items.length, foodItems: items }, null, 2));
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error('FATAL:', err.message);
  process.exit(1);
});
