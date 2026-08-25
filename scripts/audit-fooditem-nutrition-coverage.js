/**
 * Read-only audit: for every ingredient name/unit actually used across all
 * Recipes, checks whether the matching FoodItem (by normalizedName) exists,
 * has a complete nutritionPer100g (calories/protein/carbs/fats/fiber all
 * non-null), and - for any non-'g'/'ml' unit actually used by a recipe
 * (piece/tbsp/tsp/cup/etc.) - has a unitConversions entry for that unit (a
 * 'g' unit never needs a conversion; 'ml' can also resolve via `density`).
 * Makes no writes.
 *
 * Usage:
 *   node scripts/audit-fooditem-nutrition-coverage.js [outFile]
 *   (defaults to fooditem-nutrition-audit.json in the repo root)
 */
require('dotenv').config();
require('dns').setServers(['8.8.8.8', '1.1.1.1']);
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { normalize } = require('../utils/ingredientLibrary');

const OUT_FILE = process.argv[2] || path.join(__dirname, '..', 'fooditem-nutrition-audit.json');
const NUTRITION_FIELDS = ['calories', 'protein', 'carbs', 'fats', 'fiber'];

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);

  try {
    const { Recipe, FoodItem } = require('../models');

    const recipes = await Recipe.find({}).select('name servingTime ingredients').lean();
    const foodItems = await FoodItem.find({}).select('name normalizedName nutritionPer100g unitConversions density').lean();
    const foodItemByNormalizedName = new Map(foodItems.map((f) => [f.normalizedName, f]));

    // ingredientKey -> { name, unitsUsed: Set<string>, usedInRecipes: Set<string> }
    const ingredientUsage = new Map();
    for (const recipe of recipes) {
      for (const ingredient of recipe.ingredients || []) {
        const key = normalize(ingredient.name);
        if (!ingredientUsage.has(key)) {
          ingredientUsage.set(key, { name: ingredient.name, unitsUsed: new Set(), usedInRecipes: new Set() });
        }
        const entry = ingredientUsage.get(key);
        entry.unitsUsed.add(ingredient.unit);
        entry.usedInRecipes.add(recipe.name);
      }
    }

    const missingFoodItem = [];
    const incompleteNutrition = [];
    const missingUnitConversion = [];

    for (const [key, usage] of ingredientUsage.entries()) {
      const foodItem = foodItemByNormalizedName.get(key);
      const recipeNames = Array.from(usage.usedInRecipes);
      const unitsUsed = Array.from(usage.unitsUsed);

      if (!foodItem) {
        missingFoodItem.push({ ingredient: usage.name, unitsUsed, usedInRecipes: recipeNames });
        continue;
      }

      const per100g = foodItem.nutritionPer100g || {};
      const missingFields = NUTRITION_FIELDS.filter((f) => typeof per100g[f] !== 'number');
      if (missingFields.length > 0) {
        incompleteNutrition.push({
          ingredient: usage.name,
          foodItemId: String(foodItem._id),
          missingFields,
          currentNutritionPer100g: per100g,
          usedInRecipes: recipeNames,
        });
      }

      for (const unit of unitsUsed) {
        if (unit === 'g') continue;
        if (unit === 'ml' && typeof foodItem.density === 'number') continue;
        const hasConversion = typeof foodItem.unitConversions?.[unit] === 'number';
        if (!hasConversion) {
          missingUnitConversion.push({
            ingredient: usage.name,
            foodItemId: String(foodItem._id),
            unit,
            usedInRecipes: recipeNames,
          });
        }
      }
    }

    const output = {
      summary: {
        totalRecipes: recipes.length,
        totalUniqueIngredients: ingredientUsage.size,
        missingFoodItemCount: missingFoodItem.length,
        incompleteNutritionCount: incompleteNutrition.length,
        missingUnitConversionCount: missingUnitConversion.length,
      },
      missingFoodItem,
      incompleteNutrition,
      missingUnitConversion,
    };

    fs.writeFileSync(OUT_FILE, JSON.stringify(output, null, 2));
    console.log(`Wrote audit to ${OUT_FILE}`);
    console.log(JSON.stringify(output.summary, null, 2));
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
