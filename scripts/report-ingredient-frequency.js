/**
 * Read-only report: how often does each distinct ingredient name actually
 * appear across every dietician's recipes? Exists to make the v4.0 plan's
 * Phase 0c "Tier 1 seed table" concrete instead of guessing which ~150-250
 * ingredients matter - the Tier-1 nutrition data-entry work
 * (scripts/foodItemNutritionData.js) should be prioritized against this
 * output, highest-frequency first, since that's the fastest path to a real
 * per-dietician nutritionPer100g coverage number
 * (see scripts/reportFoodItemNutritionCoverage.js).
 *
 * Never writes anything - purely a Recipe.find() + in-memory aggregation.
 *
 * Usage:
 *   node scripts/report-ingredient-frequency.js            # top 50 by default
 *   node scripts/report-ingredient-frequency.js --limit=200
 *   node scripts/report-ingredient-frequency.js --json     # machine-readable, full list
 */

require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/database');
const { normalize } = require('../utils/ingredientLibrary');

const JSON_OUTPUT = process.argv.includes('--json');
const limitArg = process.argv.find((arg) => arg.startsWith('--limit='));
const LIMIT = limitArg ? parseInt(limitArg.split('=')[1], 10) : 50;

async function main() {
  console.log('Connecting to MongoDB...');
  const tlsCAFile = connectDB.resolveTlsCAFile();
  const connectOptions = tlsCAFile ? { tls: true, tlsCAFile } : {};
  await mongoose.connect(process.env.MONGODB_URI, connectOptions);
  console.log('Connected.');

  try {
    const { Recipe } = require('../models');

    const recipes = await Recipe.find({ category: { $ne: 'Supplements' } }).select('ingredients name');
    console.log(`Scanned ${recipes.length} non-Supplement recipe(s).\n`);

    // normalizedName -> { displayName (most common raw spelling), recipeCount, occurrenceCount }
    const counts = new Map();

    for (const recipe of recipes) {
      const namesSeenInThisRecipe = new Set();
      for (const ingredient of recipe.ingredients || []) {
        if (!ingredient?.name) continue;
        const key = normalize(ingredient.name);
        if (!counts.has(key)) {
          counts.set(key, { displayName: ingredient.name, recipeCount: 0, occurrenceCount: 0, rawSpellings: new Set() });
        }
        const entry = counts.get(key);
        entry.occurrenceCount += 1;
        entry.rawSpellings.add(ingredient.name);
        if (!namesSeenInThisRecipe.has(key)) {
          entry.recipeCount += 1;
          namesSeenInThisRecipe.add(key);
        }
      }
    }

    const ranked = Array.from(counts.entries())
      .map(([normalizedName, entry]) => ({
        normalizedName,
        displayName: entry.displayName,
        recipeCount: entry.recipeCount,
        occurrenceCount: entry.occurrenceCount,
        spellingVariantCount: entry.rawSpellings.size,
      }))
      .sort((a, b) => b.recipeCount - a.recipeCount);

    if (JSON_OUTPUT) {
      console.log(JSON.stringify(ranked, null, 2));
      return;
    }

    console.log(`=== Top ${Math.min(LIMIT, ranked.length)} of ${ranked.length} distinct ingredients, by recipe count ===\n`);
    console.log('recipeCount  occurrenceCount  spellingVariants  ingredient');
    for (const row of ranked.slice(0, LIMIT)) {
      console.log(
        `${String(row.recipeCount).padStart(11)}  ${String(row.occurrenceCount).padStart(15)}  ${String(row.spellingVariantCount).padStart(16)}  ${row.displayName}`
      );
    }
    console.log(
      `\nTotal distinct ingredients: ${ranked.length}. Run with --json for the full machine-readable list, ` +
        `or --limit=N to change how many rows print here.`
    );
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error('Report failed:', err);
  process.exit(1);
});
