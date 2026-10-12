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

const EXECUTE = process.argv.includes('--execute');
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) || '').slice('--only='.length) || null;

const UNIT_ALIASES = {
  g: 'g', gm: 'g', gram: 'g', grams: 'g',
  ml: 'ml',
  tsp: 'tsp', teaspoon: 'tsp', teaspoons: 'tsp',
  tbsp: 'tbsp', tablespoon: 'tbsp', tablespoons: 'tbsp',
  cup: 'cup', cups: 'cup',
  piece: 'piece', pieces: 'piece', nos: 'nos', bowl: 'bowl', bowls: 'bowl',
  egg: 'egg', eggs: 'egg', slice: 'slice', slices: 'slice',
};
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const fmt = (n) => String(Math.round(n * 100) / 100);
const close = (a, b) => Math.abs(a - b) <= Math.max(0.01, Math.abs(b) * 0.005);

const UNIT_RE = Object.keys(UNIT_ALIASES).sort((a, b) => b.length - a.length).join('|');

function fixStep(step, ingredients, skip = new Set(), counts = null) {
  let text = step;
  const changes = [];
  const manual = [];
  for (const ing of ingredients) {
    // "<qty> <unit> [(parenthetical)] [of] [the] <name>"
    const re = new RegExp(`(\\d+(?:\\.\\d+)?)(\\s*)(${UNIT_RE})\\b(\\s*(?:\\([^)]*\\)\\s*)?(?:of\\s+)?(?:the\\s+)?${esc(ing.name)}\\b)`, 'gi');
    text = text.replace(re, (m, qty, sp, unitWord, tail) => {
      if (counts) counts.set(ing.name, (counts.get(ing.name) || 0) + 1);
      if (skip.has(ing.name)) {
        manual.push(`"${m}" - ingredient is quoted in several steps (split use?), ingredient total ${fmt(ing.quantity)} ${ing.unit}`);
        return m;
      }
      const unit = UNIT_ALIASES[unitWord.toLowerCase()];
      if (unit !== ing.unit) {
        manual.push(`"${m}" (ingredient is ${fmt(ing.quantity)} ${ing.unit})`);
        return m;
      }
      if (close(parseFloat(qty), ing.quantity)) return m;
      const out = `${fmt(ing.quantity)}${sp}${unitWord}${tail}`;
      changes.push(`${m}  ->  ${out}`);
      return out;
    });
  }
  return { text, changes, manual };
}

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
      const counts = new Map();
      (v.steps || []).forEach((step) => fixStep(step, ingredients, new Set(), counts));
      const skip = new Set([...counts].filter(([, n]) => n > 1).map(([name]) => name));
      const newSteps = [];
      const lines = [];
      (v.steps || []).forEach((step, idx) => {
        const r = fixStep(step, ingredients, skip);
        newSteps.push(r.text);
        r.changes.forEach((c) => lines.push(`  step ${idx + 1}: ${c}`));
        r.manual.forEach((m) => manualAll.push(`${v.name} v${v.versionNumber} step ${idx + 1}: ${m}`));
      });
      if (!lines.length) continue;
      affected++;
      stepsFixed += lines.length;
      console.log(`\n${v.name} (v${v.versionNumber}, ${v._id})`);
      lines.forEach((l) => console.log(l));
      if (EXECUTE) await RecipeVersion.updateOne({ _id: v._id }, { $set: { steps: newSteps } });
    }

    console.log(`\n${EXECUTE ? 'UPDATED' : 'DRY RUN'}: ${affected} of ${versions.length} versions, ${stepsFixed} quantity mentions`);
    if (manualAll.length) {
      console.log(`\nNeeds manual review (unit differs, or ingredient quoted in several steps; not rewritten): ${manualAll.length}`);
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
