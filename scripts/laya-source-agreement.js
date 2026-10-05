/**
 * Smoke test: how well does Laya's meal-type answer agree with each recipe's
 * EXISTING serving slot, now that Laya cannot see that slot?
 *
 * !! This is agreement with existing labels, NOT accuracy. !!
 * The existing slot is just how someone filed the recipe: it can be wrong, and
 * many dishes fit several meals. Use this to decide whether the meal-type
 * question is worth a dietician's time, not as a result. Real accuracy needs
 * the dietician-reviewed dataset (tests/laya/README.md).
 *
 * Read-only: samples saved recipes (stratified by slot, shuffled), makes NO
 * database writes. It does call a real Laya, one request at a time. Laya
 * answers one request every ~8 s on the production VM, so 80 recipes take
 * about 11 minutes: run it at a quiet time, from the backend container's
 * Coolify Terminal (the only place both the database and Laya are reachable).
 *
 * Usage:
 *   node scripts/laya-source-agreement.js --yes [--per-class=20] [--seed=1]
 *        [--timeout-ms=30000] [--out=<file>] [--dry-run]
 *
 * --dry-run shows how many recipes would be sampled and the time estimate,
 * then exits without calling Laya. It retries a request Laya refuses (HTTP
 * 503, e.g. a real shadow call is in flight) and stops by itself if 5 calls in
 * a row fail.
 */
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const connectDB = require('../config/database');
const config = require('../config/environment');
const Recipe = require('../models/Recipe');
const { classifyRecipe } = require('../services/layaDecisionService');
const { mealTypeFromServingTime, sampleStratified, shuffleSeeded, scoreResults } = require('../utils/layaEval');
const { runSourceAgreement, perClassAgreement, disagreements } = require('../utils/layaSourceAgreement');

function parseArgs(argv) {
  const out = {};
  for (const a of argv.slice(2)) {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    if (m) out[m[1]] = m[2] === undefined ? true : m[2];
  }
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (n, d) => (d ? `${Math.round((n / d) * 100)}%` : 'n/a');

(async () => {
  const args = parseArgs(process.argv);
  const perClass = Number(args['per-class']) || 20;
  const seed = Number(args.seed) || 1;
  config.laya.timeoutMs = Number(args['timeout-ms'] || 30000);

  if (!config.laya.enabled || !config.laya.baseUrl || !config.laya.apiKey) {
    console.error('LAYA_ENABLED=true plus LAYA_BASE_URL and LAYA_API_KEY must be set (run this in the backend container).');
    process.exit(1);
  }

  await connectDB();
  const recipes = await Recipe.find({
    servingTime: { $in: ['Breakfast', 'Lunch', 'Dinner', 'Evening Snack'] },
    category: { $ne: 'Supplements' },
  })
    .select('name cuisine category servingTime ingredients.name')
    .lean();

  const sample = shuffleSeeded(
    sampleStratified(recipes, (r) => mealTypeFromServingTime(r.servingTime), perClass, seed),
    seed + 1
  );
  // The recipe given to Laya has NO servingTime; the source slot is kept beside it.
  const items = sample.map((r) => ({
    id: String(r._id),
    name: r.name,
    sourceMeal: mealTypeFromServingTime(r.servingTime),
    recipe: {
      name: r.name,
      cuisine: r.cuisine || null,
      category: r.category || null,
      ingredients: (r.ingredients || []).map((i) => ({ name: i.name })),
    },
  }));

  const perSlot = {};
  items.forEach((i) => { perSlot[i.sourceMeal] = (perSlot[i.sourceMeal] || 0) + 1; });
  const minutes = Math.ceil((items.length * 8) / 60);
  console.log('Blind agreement with EXISTING slot labels - this is NOT accuracy.');
  console.log(`Sampled ${items.length} recipes`, perSlot, `(up to ${perClass} per slot, seed ${seed}). Estimated ~${minutes} min at ~8 s a call.`);

  if (args['dry-run']) {
    console.log('--dry-run: not calling Laya.');
    await mongoose.disconnect();
    return;
  }
  if (!args.yes) {
    console.error('Refusing to run without --yes: this keeps Laya busy for the whole run (shadow calls meanwhile may be skipped). Run it at a quiet time.');
    await mongoose.disconnect();
    process.exit(1);
  }
  await mongoose.disconnect(); // nothing more is read from the database

  const started = Date.now();
  const { results, aborted } = await runSourceAgreement({
    items,
    classify: classifyRecipe,
    sleep,
    onProgress: (done, total) => {
      if (done % 5 === 0 || done === total) {
        const perCall = (Date.now() - started) / done;
        console.log(`  ${done}/${total} done, ~${Math.ceil(((total - done) * perCall) / 60000)} min left`);
      }
    },
  });
  if (aborted) console.log(`\nStopped early: ${aborted}`);

  const scored = scoreResults(results);
  const field = scored.fields.meal_type || { n: 0, correct: 0, accuracy: null, confusion: {} };
  const slots = perClassAgreement(results);
  const classes = Object.keys(slots).length || 4;

  console.log('\n=== Blind agreement with EXISTING slot labels (NOT accuracy) ===');
  console.log(`Answered ${field.n} of ${results.length}; errors/timeouts ${scored.errors}.`);
  console.log(`Overall agreement: ${field.correct}/${field.n} = ${pct(field.correct, field.n)}   (pure chance with ${classes} slots: ${pct(1, classes)})`);
  console.log('By existing slot:');
  for (const [slot, c] of Object.entries(slots)) console.log(`  ${slot.padEnd(10)} ${c.agree}/${c.n} = ${pct(c.agree, c.n)}`);
  console.log('Confusion (existing slot -> Laya answer: count):');
  for (const [k, v] of Object.entries(field.confusion).sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${v}`);
  console.log(`Mean confidence when it agrees: ${scored.meanConfidenceWhenRight}; when it differs: ${scored.meanConfidenceWhenWrong}`);
  console.log(`Latency ms: mean ${scored.latency.mean}, p50 ${scored.latency.p50}, p95 ${scored.latency.p95}`);
  console.log('Examples where Laya differs from the existing slot (many may be fair - dishes fit several meals):');
  for (const d of disagreements(results, 15)) console.log(`  ${d.name}: existing ${d.source}, Laya ${d.laya}${d.confidence != null ? ` (confidence ${d.confidence})` : ''}`);
  console.log('\nReminder: low agreement here means "worth investigating", high agreement means "not obviously broken".');
  console.log('Neither is accuracy. Only the dietician-reviewed dataset measures that.');

  const outFile = path.resolve(args.out || path.join(__dirname, '..', 'tests', 'laya', 'results', `source-agreement-${new Date().toISOString().replace(/[:.]/g, '-')}.json`));
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify({ note: 'agreement with existing slot labels, NOT accuracy', perClass, seed, aborted, scored, slots, results }, null, 2));
  console.log(`\nFull results: ${outFile}`);
})().catch((err) => {
  console.error('laya-source-agreement failed:', err.message);
  process.exit(1);
});
