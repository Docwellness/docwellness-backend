/**
 * Finds RecipeVersions whose cooking-step prose quotes an ingredient quantity
 * that disagrees with the version's own (optimized / auto-balanced / custom)
 * ingredients[] - e.g. ingredients say "Low-Fat Paneer 48.16 g" while step 1
 * says "Cut the 100 g of Low-Fat Paneer". createCustomVersion and
 * autoBalanceWeek copy `steps` verbatim from the source version, so every
 * re-portioned version keeps the base recipe's quantities in its text.
 *
 * Fix is deterministic (no AI): the number in "<qty> <unit> [of] <ingredient>"
 * is replaced by that version's ingredient quantity. A mention whose unit
 * differs from the ingredient's unit is only reported, never rewritten.
 *
 * Usage:
 *   node scripts/repair-recipe-version-step-quantities.js                 # dry run, prints every diff
 *   node scripts/repair-recipe-version-step-quantities.js --execute       # write
 *   node scripts/repair-recipe-version-step-quantities.js --only="Paneer" # name filter
 *
 * Connects via MONGODB_URI (config/database.js). In prod run it from the
 * backend container so MONGODB_URI / the TLS CA are the real ones. Always dry-run first.
 */
require('dotenv').config({ quiet: true });
const mongoose = require('mongoose');
const connectDB = require('../config/database');
const { rewriteStepQuantities } = require('../utils/recipeStepQuantities');

const EXECUTE = process.argv.includes('--execute');
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) || '').slice('--only='.length) || null;

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function main() {
  await connectDB();
  try {
    const { RecipeVersion, FoodItem } = require('../models');
    const filter = { status: 'Active' };
    if (ONLY) filter.name = new RegExp(esc(ONLY), 'i');
    const versions = await RecipeVersion.find(filter).select('name versionNumber ingredients steps').lean();

    const ids = new Set();
    versions.forEach((v) => (v.ingredients || []).forEach((i) => ids.add(String(i.foodItemId))));
    const foods = await FoodItem.find({ _id: { $in: [...ids] } }).select('name').lean();
    const nameById = new Map(foods.map((f) => [String(f._id), f.name]));

    let affected = 0;
    let stepsFixed = 0;
    const manualAll = [];
    for (const v of versions) {
      const ingredients = (v.ingredients || [])
        .map((i) => ({ name: nameById.get(String(i.foodItemId)), quantity: i.rawQuantity, unit: i.unit }))
        .filter((i) => i.name && i.quantity > 0)
        .sort((a, b) => b.name.length - a.name.length);
      const { steps: newSteps, changes } = rewriteStepQuantities(v.steps || [], ingredients, {
        onSkip: ({ stepIndex, text, reason, ingredient }) =>
          manualAll.push(`${v.name} v${v.versionNumber} step ${stepIndex + 1}: "${text}" - ${reason} (ingredient is ${ingredient.quantity} ${ingredient.unit})`),
      });
      const lines = changes.map((c) => `  step ${c.stepIndex + 1}: ${c.before}  ->  ${c.after}`);
      if (!lines.length) continue;
      affected++;
      stepsFixed += lines.length;
      console.log(`\n${v.name} (v${v.versionNumber}, ${v._id})`);
      lines.forEach((l) => console.log(l));
      if (EXECUTE) await RecipeVersion.updateOne({ _id: v._id }, { $set: { steps: newSteps } });
    }

    console.log(`\n${EXECUTE ? 'UPDATED' : 'DRY RUN'}: ${affected} of ${versions.length} versions, ${stepsFixed} quantity mentions`);
    if (manualAll.length) {
      console.log(`\nNeeds manual review (not rewritten): ${manualAll.length}`);
      manualAll.forEach((m) => console.log('  ' + m));
    }
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
