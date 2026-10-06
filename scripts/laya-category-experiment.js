/**
 * Category experiment: can Laya recover a recipe's `category` from its name
 * (and ingredients), compared with a trained baseline?
 *
 * Why: the production probe (2026-10-06) showed the plan's evaluation datasets
 * cannot be built from user data yet, but all 215 recipes carry a dietician-set
 * category. This is the one decision we can still measure. It is a mix of
 * cuisine, diet and product type, so expect imperfect agreement from ANY method.
 *
 * !! Agreement with the existing label, NOT accuracy. !!
 * Hidden from Laya: `category` (the answer) and `cuisine` (a near copy of it).
 * Laya sees only the name, plus the ingredient names in the second variant.
 * Reference: multinomial naive Bayes on the same words, trained on the other
 * labelled recipes (leave-one-out), uniform prior (the sample is balanced).
 *
 * Read-only. Calls a real Laya one request at a time (shadowing is off). Run it
 * at a quiet time in the backend container's Coolify Terminal.
 *
 * Usage:
 *   node scripts/laya-category-experiment.js --dry-run
 *   node scripts/laya-category-experiment.js --yes [--per-class=5] [--min-class=5] [--seed=1]
 *        [--exclude=Other] [--timeout-ms=60000] [--out=<file>]
 */
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const { sampleStratified, shuffleSeeded } = require('../utils/layaEval');
const {
  selectClasses,
  buildCategoryRequest,
  categoryProbabilities,
  categoryMetrics,
  leaveOneOutBaseline,
} = require('../utils/layaCategory');

function parseArgs(argv) {
  const out = {};
  for (const a of argv.slice(2)) {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    if (m) out[m[1]] = m[2] === undefined ? true : m[2];
  }
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (v) => (v == null ? 'n/a' : `${Math.round(v * 100)}%`);
const f2 = (v) => (v == null ? 'n/a' : Number(v).toFixed(2));

/** One Laya call with a short wait-and-retry while Laya is busy (HTTP 503). */
async function askWithRetry(askLaya, request, retries = 3) {
  let r;
  for (let attempt = 0; ; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop
    r = await askLaya(request);
    if (!r.ok && /HTTP 503/.test(r.detail || '') && attempt < retries) {
      // eslint-disable-next-line no-await-in-loop
      await sleep(3000);
      continue;
    }
    return r;
  }
}

(async () => {
  const args = parseArgs(process.argv);
  const mongoose = require('mongoose');
  const connectDB = require('../config/database');
  const config = require('../config/environment');
  const Recipe = require('../models/Recipe');
  const { askLaya } = require('../services/layaDecisionService');

  const perClass = Number(args['per-class']) || 5;
  const minClass = Number(args['min-class']) || 5;
  const seed = Number(args.seed) || 1;
  const exclude = args.exclude && args.exclude !== true ? String(args.exclude).split(',').map((s) => s.trim()) : ['Other'];
  config.laya.timeoutMs = Number(args['timeout-ms'] || 60000);

  if (!args['dry-run'] && (!config.laya.enabled || !config.laya.baseUrl || !config.laya.apiKey)) {
    console.error('LAYA_ENABLED=true plus LAYA_BASE_URL and LAYA_API_KEY must be set (run this in the backend container).');
    process.exit(1);
  }

  await connectDB();
  const docs = await Recipe.find({ category: { $exists: true, $nin: [null, ''] } }).select('name category ingredients.name').lean();
  await mongoose.disconnect(); // nothing more is read from the database

  const recipes = docs.map((r) => ({
    id: String(r._id),
    name: r.name,
    category: r.category,
    ingredients: (r.ingredients || []).map((i) => ({ name: i.name })),
  }));
  const classes = selectClasses(recipes, { minPerClass: minClass, exclude });
  const keyOf = new Map(classes.map((c) => [c.name, c.key]));
  const pool = recipes.filter((r) => keyOf.has(r.category));
  const sample = shuffleSeeded(sampleStratified(pool, (r) => r.category, perClass, seed), seed + 1);

  console.log('Category experiment: agreement with the EXISTING category label - this is NOT accuracy.');
  console.log(`${classes.length} categories with >= ${minClass} recipes (excluded: ${exclude.join(', ') || 'none'}): ${classes.map((c) => `${c.name} ${c.count}`).join(', ')}`);
  console.log(`Sampled ${sample.length} recipes (up to ${perClass} per category, seed ${seed}); category and cuisine are NOT sent to Laya.`);
  console.log(`Estimate: 2 variants x ${sample.length} calls x ~3-5 s = ~${Math.ceil((2 * sample.length * 4) / 60)} min.`);
  if (args['dry-run']) {
    console.log('--dry-run: not calling Laya.');
    return;
  }
  if (!args.yes) {
    console.error('Refusing to run without --yes: this keeps Laya busy for the whole run. Run it at a quiet time.');
    process.exit(1);
  }

  const variants = [
    { id: 'laya_name', label: 'Laya: name only', withIngredients: false },
    { id: 'laya_name_ingredients', label: 'Laya: name + ingredients', withIngredients: true },
  ];
  const rows = [];
  for (const v of variants) {
    console.log(`\n--- ${v.id} ---`);
    const started = Date.now();
    const items = [];
    const tokens = [];
    const latency = [];
    let errors = 0;
    let consecutive = 0;
    for (let i = 0; i < sample.length; i += 1) {
      const rec = sample[i];
      // eslint-disable-next-line no-await-in-loop
      const r = await askWithRetry(askLaya, buildCategoryRequest(rec, classes, { withIngredients: v.withIngredients }));
      if (r.ok) {
        consecutive = 0;
        items.push({ trueKey: keyOf.get(rec.category), probs: categoryProbabilities(r.answers, classes) });
        if (r.usage && typeof r.usage.input_tokens === 'number') tokens.push(r.usage.input_tokens);
        latency.push(r.latencyMs);
      } else {
        errors += 1;
        consecutive += 1;
        if (consecutive >= 5) {
          console.log(`Stopped early: 5 calls in a row failed (last: ${r.reason}${r.detail ? `: ${r.detail}` : ''})`);
          break;
        }
      }
      if (i === 0 || (i + 1) % 10 === 0 || i + 1 === sample.length) {
        console.log(`  ${i + 1}/${sample.length}, ${((Date.now() - started) / (i + 1) / 1000).toFixed(1)} s a call`);
      }
    }
    const mean = (a) => (a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : null);
    rows.push({ id: v.id, label: v.label, metrics: categoryMetrics(items, classes), tokens: mean(tokens), ms: mean(latency), errors });
  }

  // Baselines on the same sample, trained on every other labelled recipe in these categories.
  for (const withIngredients of [false, true]) {
    const loo = leaveOneOutBaseline(pool, classes, { withIngredients });
    const items = sample.map((r) => ({ trueKey: keyOf.get(r.category), probs: loo.get(r.id) }));
    rows.push({
      id: withIngredients ? 'nb_name_ingredients' : 'nb_name',
      label: `Naive Bayes: ${withIngredients ? 'name + ingredients' : 'name only'} (trained on labels)`,
      metrics: categoryMetrics(items, classes),
      tokens: null,
      ms: null,
      errors: 0,
    });
  }

  const chance = rows[0].metrics;
  console.log('\n=== Category: agreement with the existing label (NOT accuracy) ===');
  console.log(`${classes.length} categories; chance: mean rank ${f2(chance.chanceMeanRank)}, top-1 ${pct(chance.chanceTop1)}, top-2 ${pct(chance.chanceTop2)}, AUC 0.50\n`);
  console.log(`${'method'.padEnd(24)}${'n'.padStart(4)}${'tokens'.padStart(8)}${'ms/call'.padStart(9)}${'mean rank'.padStart(11)}${'top-1'.padStart(7)}${'top-2'.padStart(7)}${'AUC'.padStart(7)}  errors`);
  for (const r of rows) {
    const m = r.metrics;
    console.log(`${r.id.padEnd(24)}${String(m.n).padStart(4)}${String(r.tokens ?? '-').padStart(8)}${String(r.ms ?? '-').padStart(9)}${f2(m.meanRank).padStart(11)}${pct(m.top1).padStart(7)}${pct(m.top2).padStart(7)}${f2(m.macroAuc).padStart(7)}  ${r.errors || ''}`);
  }

  const best = rows.filter((r) => r.id.startsWith('laya')).sort((a, b) => (b.metrics.macroAuc || 0) - (a.metrics.macroAuc || 0))[0];
  const nb = rows.find((r) => r.id === 'nb_name_ingredients');
  console.log(`\nPer category, top-1 (${best.id} vs ${nb.id}):`);
  for (const c of classes) {
    const a = best.metrics.perClass?.[c.name];
    const b = nb.metrics.perClass?.[c.name];
    console.log(`  ${c.name.padEnd(20)} n=${String(a ? a.n : 0).padStart(2)}  laya ${pct(a?.top1).padStart(5)}  baseline ${pct(b?.top1).padStart(5)}`);
  }
  console.log('\nDifferences under ~0.05 AUC are within noise at this sample size. The category label mixes cuisine, diet and');
  console.log('product type, so agreement is capped for any method: read it as a comparison, not an accuracy.');

  const outFile = path.resolve(args.out || path.join(__dirname, '..', 'tests', 'laya', 'results', `category-experiment-${new Date().toISOString().replace(/[:.]/g, '-')}.json`));
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify({ note: 'agreement with existing category labels, NOT accuracy', classes, perClass, seed, rows }, null, 2));
  console.log(`\nFull results: ${outFile}`);
})().catch((err) => {
  console.error('laya-category-experiment failed:', err.message);
  process.exit(1);
});
