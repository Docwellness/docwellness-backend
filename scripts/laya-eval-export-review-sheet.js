/**
 * Builds a REVIEW SHEET for the Laya evaluation dataset from real, already-
 * saved recipes - so dieticians label real data instead of starting from a
 * blank page. Read-only; makes no database writes.
 *
 * This does NOT create evaluation data. Every row it writes has
 * `expected: null` and `reviewed_by: null`, and scripts/laya-eval-run.js
 * ignores rows in that state. A row only counts once a dietician fills in
 * `expected` and sets `reviewed_by: "dietician"` (see tests/laya/README.md).
 *
 * Deliberately excludes Laya's own prediction from the sheet, so a reviewer
 * isn't anchored by what the model said. `proposed` is just the recipe's
 * existing servingTime, as a starting point to confirm or correct.
 *
 * Usage:
 *   node scripts/laya-eval-export-review-sheet.js [--per-class=25] [--seed=1]
 *        [--out=tests/laya/pending/recipe_classification.pending.json]
 *
 * Stratified by meal type (breakfast/lunch/dinner/snack). Drinks and Brunch
 * have no single clean meal type, so they are not sampled.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const connectDB = require('../config/database');
const Recipe = require('../models/Recipe');
const { mealTypeFromServingTime, sampleStratified } = require('../utils/layaEval');

function parseArgs(argv) {
  const out = {};
  for (const a of argv.slice(2)) {
    const m = a.match(/^--([^=]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

(async () => {
  const args = parseArgs(process.argv);
  const perClass = Number(args['per-class']) || 25;
  const seed = Number(args.seed) || 1;
  const outFile = path.resolve(
    args.out || path.join(__dirname, '..', 'tests', 'laya', 'pending', 'recipe_classification.pending.json')
  );

  await connectDB();
  const recipes = await Recipe.find({ servingTime: { $in: ['Breakfast', 'Lunch', 'Dinner', 'Evening Snack'] } })
    .select('name cuisine category servingTime ingredients.name')
    .lean();

  const sample = sampleStratified(recipes, (r) => mealTypeFromServingTime(r.servingTime), perClass, seed);

  const counts = {};
  const sheet = sample.map((r) => {
    const proposed = mealTypeFromServingTime(r.servingTime);
    counts[proposed] = (counts[proposed] || 0) + 1;
    return {
      id: String(r._id),
      input: {
        recipe: {
          name: r.name,
          cuisine: r.cuisine || null,
          category: r.category || null,
          servingTime: r.servingTime,
          ingredients: (r.ingredients || []).map((i) => ({ name: i.name })),
        },
      },
      // Starting point only - the reviewer confirms or corrects it.
      proposed: { meal_type: proposed },
      // The reviewer fills these in. protein_level: "low" | "moderate" | "high".
      expected: null,
      reviewed_by: null,
    };
  });

  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(sheet, null, 2));
  console.log(`Wrote ${sheet.length} unreviewed rows to ${outFile}`);
  console.log('Per meal type:', counts, `(requested up to ${perClass} each, seed ${seed})`);
  console.log('Nothing here is evaluation data until a dietician fills `expected` and sets reviewed_by:"dietician".');
  await mongoose.disconnect();
})().catch((err) => {
  console.error('export failed:', err.message);
  process.exit(1);
});
