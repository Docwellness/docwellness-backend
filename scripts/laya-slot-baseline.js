/**
 * Does Laya tell us anything the data did not already say?
 *
 * Scores trivial, non-LLM baselines on "which serving slot does this recipe
 * suit?" - the global base rate, the category's usual slot, and a small
 * bag-of-words classifier over name/category/cuisine/ingredients - each
 * trained on the recipes' EXISTING slot labels and scored LEAVE-ONE-OUT (every
 * recipe is scored by a model that never saw it). Reports the same rank
 * metrics as scripts/laya-source-agreement.js so they can be read side by side
 * (utils/layaRank.js: mean rank, top-1/2/3 vs chance, AUC).
 *
 * Pass --laya=<results.json> (saved by laya-source-agreement.js) to score Laya
 * on EXACTLY the same recipes and print the comparison. Without it, the sample
 * is rebuilt the way the smoke test builds it (same --per-class and --seed).
 *
 * Read-only and cheap: reads the recipe collection, calls no Laya, takes
 * seconds. Run it in the backend container's Coolify Terminal (the only place
 * the production database is reachable).
 *
 * Reading it honestly: the baselines learned from your labels and Laya never
 * saw them, so beating them is a high bar and matching them with no training
 * data is still a result. But if a simple baseline clearly beats Laya, the
 * extra cost and ~11 s a call need a different justification. This is still
 * agreement with EXISTING labels, not accuracy (tests/laya/README.md).
 *
 * Usage:
 *   node scripts/laya-slot-baseline.js [--laya=<results.json>] [--per-class=10] [--seed=1]
 */
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const connectDB = require('../config/database');
const Recipe = require('../models/Recipe');
const { sampleStratified, shuffleSeeded } = require('../utils/layaEval');
const { SLOT_KEYS, SLOT_NAMES, slotKeyFromServingTime, slotName } = require('../utils/layaSlots');
const { rankMetrics } = require('../utils/layaRank');
const { leaveOneOut } = require('../utils/layaBaselines');

function parseArgs(argv) {
  const out = {};
  for (const a of argv.slice(2)) {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    if (m) out[m[1]] = m[2] === undefined ? true : m[2];
  }
  return out;
}

const pct = (v) => (v == null ? 'n/a' : `${Math.round(v * 100)}%`);
const f2 = (v) => (v == null ? 'n/a' : v.toFixed(2));

// `noAuc`: a baseline that scores every recipe alike (the base rate) has no AUC; leave-one-out
// would show a meaningless 0.00 (removing a recipe lowers its own slot's count), so say n/a.
function summaryRow(label, m, { noAuc = false } = {}) {
  return `  ${label.padEnd(30)} rank ${String(f2(m.meanBestAcceptedRank)).padStart(4)}   top-1 ${pct(m.topK[1].rate).padStart(4)}   top-2 ${pct(m.topK[2].rate).padStart(4)}   top-3 ${pct(m.topK[3].rate).padStart(4)}   macro AUC ${noAuc ? 'n/a (same for every recipe)' : f2(m.macroAuc)}`;
}

(async () => {
  const args = parseArgs(process.argv);
  const perClass = Number(args['per-class']) || 10;
  const seed = Number(args.seed) || 1;

  await connectDB();
  const docs = await Recipe.find({ servingTime: { $in: SLOT_NAMES }, category: { $ne: 'Supplements' } })
    .select('name cuisine category servingTime ingredients.name')
    .lean();
  await mongoose.disconnect();

  const recipes = docs.map((r) => ({
    id: String(r._id),
    name: r.name,
    cuisine: r.cuisine || null,
    category: r.category || null,
    slot: slotKeyFromServingTime(r.servingTime),
    ingredients: (r.ingredients || []).map((i) => ({ name: i.name })),
  }));
  const loo = leaveOneOut(recipes);
  const byId = new Map(recipes.map((r) => [r.id, r]));

  // Which recipes to compare on: Laya's saved sample if given, else the smoke test's sample.
  let laya = null;
  let sampleIds;
  if (args.laya) {
    const saved = JSON.parse(fs.readFileSync(path.resolve(args.laya), 'utf8'));
    laya = new Map((saved.results || []).filter((r) => r.slotProbs).map((r) => [r.id, r]));
    sampleIds = [...laya.keys()].filter((id) => byId.has(id));
    console.log(`Laya results from ${args.laya}: ${laya.size} answered recipes, ${sampleIds.length} found in the database (slot form: ${saved.slotMode || 'unknown'}).`);
  } else {
    sampleIds = shuffleSeeded(sampleStratified(recipes, (r) => r.slot, perClass, seed), seed + 1).map((r) => r.id);
  }

  const score = (ids, probsOf) => rankMetrics(ids.map((id) => ({ accepted: [byId.get(id).slot], probs: probsOf(id) })).filter((x) => x.probs));
  const methods = [
    ['Base rate (no recipe info)', (id) => loo[id].global],
    ['Category prior', (id) => loo[id].category],
    ['Bag-of-words (naive Bayes)', (id) => loo[id].naiveBayes],
  ];

  console.log('\nBaselines trained on the existing slot labels, scored leave-one-out. NOT accuracy.');
  console.log(`Recipes in the database (7 slots, no supplements): ${recipes.length}.`);
  console.log(`\n=== On the ${sampleIds.length}-recipe sample ===  (chance: rank 4.00, top-1 14%, top-2 29%, top-3 43%, AUC 0.50)`);
  const results = {};
  for (const [label, fn] of methods) {
    results[label] = score(sampleIds, fn);
    console.log(summaryRow(label, results[label], { noAuc: label.startsWith('Base rate') }));
  }
  if (laya) {
    results.Laya = score(sampleIds, (id) => laya.get(id).slotProbs);
    console.log(summaryRow(`Laya (${slotNameOfMode(args.laya)})`, results.Laya));
  }

  const allIds = recipes.map((r) => r.id);
  console.log(`\n=== On all ${allIds.length} recipes (leave-one-out; more stable) ===`);
  for (const [label, fn] of methods) console.log(summaryRow(label, score(allIds, fn), { noAuc: label.startsWith('Base rate') }));
  console.log('  (On all recipes the slots are NOT evenly spread, so the base-rate row shows what always guessing the most common slot scores.)');

  const nb = results['Bag-of-words (naive Bayes)'];
  console.log('\nPer-slot AUC on the sample (0.5 = no signal):');
  console.log(`  ${'slot'.padEnd(14)} ${'base'.padStart(5)} ${'category'.padStart(8)} ${'bag-of-words'.padStart(12)}${laya ? ` ${'Laya'.padStart(6)}` : ''}`);
  for (const k of SLOT_KEYS) {
    const cells = [results['Category prior'], nb].map((m) => f2(m.aucBySlot[k].auc));
    console.log(`  ${slotName(k).padEnd(14)} ${'-'.padStart(5)} ${cells[0].padStart(8)} ${cells[1].padStart(12)}${laya ? ` ${f2(results.Laya.aucBySlot[k].auc).padStart(6)}` : ''}`);
  }
  console.log('  (Category-prior AUCs at or below 0.5 are a leave-one-out artifact - leaving a recipe out lowers its own slot\'s count -');
  console.log('   not evidence that the category misleads. Read the bag-of-words column as the real baseline.)');

  if (laya) {
    const L = results.Laya;
    console.log('\n=== Verdict inputs (same recipes) ===');
    console.log(`Laya macro AUC ${f2(L.macroAuc)} vs bag-of-words ${f2(nb.macroAuc)} vs category prior ${f2(results['Category prior'].macroAuc)}.`);
    console.log(`Laya top-1 ${pct(L.topK[1].rate)} vs bag-of-words ${pct(nb.topK[1].rate)} vs category prior ${pct(results['Category prior'].topK[1].rate)}.`);
    const diff = (L.macroAuc || 0) - (nb.macroAuc || 0);
    console.log(
      diff > 0.05
        ? 'Laya is ahead of the bag-of-words baseline on this sample: it adds something the labels did not already say.'
        : diff < -0.05
          ? 'The bag-of-words baseline is clearly ahead of Laya: Laya\'s ~11 s calls are not buying better slot judgement than a few lines of code trained on your labels.'
          : 'Laya and the bag-of-words baseline are about level: Laya matches a trained baseline with no training data; whether that is worth ~11 s a call is a judgement.'
    );
    console.log('(70 recipes is small: differences under ~0.05 AUC are within noise. Agreement with existing labels, NOT accuracy.)');
  } else {
    console.log('\nPass --laya=<results.json> from laya-source-agreement.js to score Laya on the same recipes.');
  }
})().catch((err) => {
  console.error('laya-slot-baseline failed:', err.message);
  process.exit(1);
});

// "choice" / "noul" from a results file name like source-agreement-choice-2026-....json, for the label only.
function slotNameOfMode(file) {
  const m = path.basename(String(file)).match(/source-agreement-(choice|noul)-/);
  return m ? m[1] : 'saved run';
}
