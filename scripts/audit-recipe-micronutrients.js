/**
 * Read-only audit for openspec/changes/fill-recipe-micronutrients: reports,
 * for the nine new micronutrient fields (saturatedFat, transFat, sugar,
 * cholesterol, sodium, calcium, iron, potassium, vitaminC), exactly what's
 * missing and why - this is the "identify all such recipes" deliverable
 * from the user's original request, and the baseline this change's
 * section 5.2 diffs the post-migration state against. Makes no writes.
 *
 * Reports three things:
 *   - foodItems: every FoodItem, and each of the nine nutrients' status
 *     (researched / verified-zero / unknown, from micronutrientProvenance -
 *     defaulting to 'unknown' when no provenance entry exists yet).
 *   - recipeVersions: every RecipeVersion, its micronutrientsIncomplete
 *     list (computed by recipeVersioningService.js at creation time), and
 *     which of ITS ingredients are the ones dragging a nutrient to null
 *     (name-matched, so it's actionable - "research Ghee's sodium", not
 *     just "Palak Paneer's sodium is null").
 *   - unresolvedIngredientNames: ingredient names on a recipe that don't
 *     resolve to any FoodItem at all (same condition
 *     scripts/audit-fooditem-nutrition-coverage.js already reports for the
 *     five macros - surfaced here too since an unresolved ingredient also
 *     blocks every micronutrient, not just macros).
 *
 * Usage:
 *   node scripts/audit-recipe-micronutrients.js [outFile]
 *   (defaults to scripts/data/recipe-micronutrient-audit-<timestamp>.json)
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const connectDB = require('../config/database');

const MICRONUTRIENT_FIELDS = [
  'saturatedFat', 'transFat', 'sugar',
  'cholesterol', 'sodium', 'calcium', 'iron', 'potassium', 'vitaminC',
];

const DEFAULT_OUT_FILE = () =>
  path.join(__dirname, 'data', `recipe-micronutrient-audit-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);

async function main() {
  // Never mongoose.connect(uri) directly - prod's self-hosted Mongo needs
  // the custom CA file connectDB() builds (see config/database.js). Not
  // that this read-only script is ever run against prod (no session has
  // prod access), but the convention is followed for consistency with
  // every other script in this repo.
  await connectDB();

  try {
    const { Recipe, FoodItem, RecipeVersion } = require('../models');

    const foodItems = await FoodItem.find({}).lean();
    const foodItemById = new Map(foodItems.map((f) => [String(f._id), f]));

    const recipeVersions = await RecipeVersion.find({}).lean();
    const recipes = await Recipe.find({}).select('name').lean();
    const recipeNameById = new Map(recipes.map((r) => [String(r._id), r.name]));

    // --- FoodItems ---
    const foodItemReport = foodItems.map((f) => {
      const per100g = f.nutritionPer100g || {};
      const provenance = f.micronutrientProvenance instanceof Map
        ? Object.fromEntries(f.micronutrientProvenance)
        : f.micronutrientProvenance || {};
      const nutrientStatus = {};
      for (const field of MICRONUTRIENT_FIELDS) {
        nutrientStatus[field] = provenance[field]?.status || (typeof per100g[field] === 'number' ? 'researched' : 'unknown');
      }
      return {
        foodItemId: String(f._id),
        name: f.name,
        normalizedName: f.normalizedName,
        nutrientStatus,
        missingCount: MICRONUTRIENT_FIELDS.filter((field) => nutrientStatus[field] === 'unknown').length,
      };
    });

    // --- RecipeVersions (+ which ingredient is responsible for each null) ---
    const recipeVersionReport = [];
    const unresolvedIngredientNamesSet = new Set();
    for (const version of recipeVersions) {
      const incomplete = version.micronutrientsIncomplete || [];
      const ingredientNames = (version.ingredients || []).map((ing) => {
        const foodItem = foodItemById.get(String(ing.foodItemId));
        if (!foodItem) unresolvedIngredientNamesSet.add(`unresolved:${ing.foodItemId}`);
        return foodItem?.name || `(unresolved FoodItem ${ing.foodItemId})`;
      });

      // For each incomplete nutrient, name exactly which ingredient(s) on
      // THIS version lack it - actionable research priority, not just a
      // recipe-level "something's missing".
      const missingBecauseOf = {};
      for (const field of incomplete) {
        missingBecauseOf[field] = (version.ingredients || [])
          .map((ing) => {
            const foodItem = foodItemById.get(String(ing.foodItemId));
            if (!foodItem) return foodItem?.name || `(unresolved FoodItem ${ing.foodItemId})`;
            const per100g = foodItem.nutritionPer100g || {};
            return typeof per100g[field] === 'number' ? null : foodItem.name;
          })
          .filter(Boolean);
      }

      recipeVersionReport.push({
        recipeVersionId: String(version._id),
        recipeName: recipeNameById.get(String(version.parentRecipeId)) || '(unknown recipe)',
        versionNumber: version.versionNumber,
        ingredientNames,
        hasUnresolvedIngredients: version.hasUnresolvedIngredients,
        unresolvedIngredientNames: version.unresolvedIngredientNames || [],
        micronutrientsIncomplete: incomplete,
        missingBecauseOf,
      });
    }

    const totalNutrientCells = recipeVersions.length * MICRONUTRIENT_FIELDS.length;
    const nullNutrientCells = recipeVersionReport.reduce((sum, r) => sum + r.micronutrientsIncomplete.length, 0);

    const output = {
      generatedAt: new Date().toISOString(),
      summary: {
        totalFoodItems: foodItems.length,
        totalRecipeVersions: recipeVersions.length,
        recipesWithUnresolvedIngredients: recipeVersionReport.filter((r) => r.hasUnresolvedIngredients).length,
        totalMicronutrientCells: totalNutrientCells,
        nullMicronutrientCells: nullNutrientCells,
        nullMicronutrientCellsPct: totalNutrientCells > 0 ? Math.round((nullNutrientCells / totalNutrientCells) * 10000) / 100 : 0,
        foodItemsWithAnyMissingNutrient: foodItemReport.filter((f) => f.missingCount > 0).length,
      },
      foodItems: foodItemReport,
      recipeVersions: recipeVersionReport,
    };

    const outFile = process.argv[2] || DEFAULT_OUT_FILE();
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, JSON.stringify(output, null, 2));
    console.log(`Wrote audit to ${outFile}`);
    console.log(JSON.stringify(output.summary, null, 2));
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
