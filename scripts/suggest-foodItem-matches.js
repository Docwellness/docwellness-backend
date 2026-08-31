/**
 * Read-only diagnostic. For every recipe ingredient name that
 * syncV1FromRecipe can't resolve to a FoodItem, prints the closest
 * FoodItem candidates (by token overlap) with their per-100g nutrition,
 * so a human can decide per name: rename the ingredient on the recipe to
 * an existing FoodItem, or add a new FoodItem.
 *
 * Pairs with backfill-recipe-versions.js (which does the actual re-sync).
 * Never writes.
 *
 * Usage:
 *   node scripts/suggest-foodItem-matches.js
 */

require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/database');
const { normalize } = require('../utils/ingredientLibrary');

function tokens(s) {
  return new Set(
    String(s)
      .toLowerCase()
      .replace(/[()]/g, ' ')
      .split(/[^a-z0-9]+/)
      .filter(Boolean)
  );
}

function overlapScore(a, b) {
  const ta = tokens(a);
  const tb = tokens(b);
  let hits = 0;
  for (const t of ta) if (tb.has(t)) hits += 1;
  return hits / Math.max(ta.size, tb.size, 1);
}

async function main() {
  console.log('Connecting to MongoDB...');
  const tlsCAFile = connectDB.resolveTlsCAFile();
  const connectOptions = tlsCAFile ? { tls: true, tlsCAFile } : {};
  await mongoose.connect(process.env.MONGODB_URI, connectOptions);
  console.log('Connected.\n');

  try {
    const { Recipe, FoodItem } = require('../models');

    const recipes = await Recipe.find({ category: { $ne: 'Supplements' } }).select('name ingredients').lean();
    const foodItems = await FoodItem.find({}).select('name normalizedName nutritionPer100g').lean();
    const matchedNorm = new Set(foodItems.map((f) => f.normalizedName));

    // name -> { recipes: Set }
    const unresolved = new Map();
    for (const r of recipes) {
      for (const ing of r.ingredients || []) {
        if (!matchedNorm.has(normalize(ing.name))) {
          if (!unresolved.has(ing.name)) unresolved.set(ing.name, new Set());
          unresolved.get(ing.name).add(r.name);
        }
      }
    }

    if (unresolved.size === 0) {
      console.log('Nothing unresolved - every recipe ingredient maps to a FoodItem.');
      return;
    }

    console.log(`${unresolved.size} unresolved ingredient name(s) across ${recipes.length} recipes:\n`);

    for (const [name, recipeSet] of [...unresolved.entries()].sort()) {
      console.log('────────────────────────────────────────────────────────');
      console.log(`"${name}"   (in: ${[...recipeSet].join(', ')})`);
      const ranked = foodItems
        .map((f) => ({ f, score: overlapScore(name, f.name) }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 5);
      if (ranked.length === 0) {
        console.log('  no FoodItem shares a word - needs a new FoodItem, or is negligible (e.g. a starter culture / pinch of spice)');
        continue;
      }
      for (const { f, score } of ranked) {
        const n = f.nutritionPer100g || {};
        console.log(
          `  ${(score * 100).toFixed(0).padStart(3)}%  ${f.name.padEnd(28)}  ` +
            `${n.calories ?? '?'} kcal / ${n.protein ?? '?'}p / ${n.carbs ?? '?'}c / ${n.fats ?? '?'}f / ${n.fiber ?? '?'}fib per 100g`
        );
      }
    }
    console.log('────────────────────────────────────────────────────────');
    console.log('\nDecide per name: rename the ingredient on the recipe (in-app: Update AI Inputs)');
    console.log('to a listed FoodItem, or add a FoodItem. Then re-run:');
    console.log('  node scripts/backfill-recipe-versions.js --execute');
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error('Failed:', err);
  process.exit(1);
});
