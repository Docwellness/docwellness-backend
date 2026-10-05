/**
 * Smoke test: does Laya rate each recipe's EXISTING serving slot as suitable,
 * now that it cannot see that slot, and is it discriminating between slots?
 * Also measures the per-call latency of the eight-question request.
 *
 * !! This is agreement with existing labels, NOT accuracy. !!
 * The existing slot is just how someone filed the recipe: it can be wrong, and
 * a recipe can suit several slots, so it is ONE acceptable slot, not the only
 * one. Use this to decide whether the slot questions are worth a dietician's
 * time, not as a result. Real accuracy needs the dietician-reviewed dataset
 * (tests/laya/README.md).
 *
 * Read-only: samples saved recipes (stratified by slot across all seven,
 * shuffled), makes NO database writes. It does call a real Laya, one request at
 * a time (it serves one at a time), so it keeps Laya busy for the whole run: run
 * it at a quiet time, from the backend container's Coolify Terminal (the only
 * place both the database and Laya are reachable). Time per recipe is unknown
 * for the eight-question request until measured; the estimate shown is a guess
 * from the old two-question call and is corrected as it runs.
 *
 * Usage:
 *   node scripts/laya-source-agreement.js --yes [--per-class=10] [--seed=1]
 *        [--timeout-ms=60000] [--out=<file>] [--dry-run]
 *
 * --dry-run shows how many recipes would be sampled, then exits without calling
 * Laya. It retries a request Laya refuses (HTTP 503, e.g. a real shadow call is
 * in flight) and stops by itself if 5 calls in a row fail.
 */
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const connectDB = require('../config/database');
const config = require('../config/environment');
const Recipe = require('../models/Recipe');
const { classifyRecipe } = require('../services/layaDecisionService');
const { sampleStratified, shuffleSeeded, summarizeLatencies } = require('../utils/layaEval');
const { SLOT_KEYS, SLOT_NAMES, slotKeyFromServingTime, slotName } = require('../utils/layaSlots');
const { runSourceAgreement, slotAgreement, slotYesRates, topPickConfusion, notRatedSuitable } = require('../utils/layaSourceAgreement');

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

(async () => {
  const args = parseArgs(process.argv);
  const perClass = Number(args['per-class']) || 10;
  const seed = Number(args.seed) || 1;
  // Eight questions in one call are slower than the old two: allow for it.
  config.laya.timeoutMs = Number(args['timeout-ms'] || 60000);

  if (!config.laya.enabled || !config.laya.baseUrl || !config.laya.apiKey) {
    console.error('LAYA_ENABLED=true plus LAYA_BASE_URL and LAYA_API_KEY must be set (run this in the backend container).');
    process.exit(1);
  }

  await connectDB();
  const recipes = await Recipe.find({
    servingTime: { $in: SLOT_NAMES },
    category: { $ne: 'Supplements' },
  })
    .select('name cuisine category servingTime ingredients.name')
    .lean();

  const sample = shuffleSeeded(
    sampleStratified(recipes, (r) => slotKeyFromServingTime(r.servingTime), perClass, seed),
    seed + 1
  );
  // The recipe given to Laya has NO servingTime; the source slot is kept beside it.
  const items = sample.map((r) => ({
    id: String(r._id),
    name: r.name,
    sourceSlot: slotKeyFromServingTime(r.servingTime),
    recipe: {
      name: r.name,
      cuisine: r.cuisine || null,
      category: r.category || null,
      ingredients: (r.ingredients || []).map((i) => ({ name: i.name })),
    },
  }));

  const perSlot = {};
  items.forEach((i) => { perSlot[slotName(i.sourceSlot)] = (perSlot[slotName(i.sourceSlot)] || 0) + 1; });
  console.log('Blind check of Laya\'s serving-slot answers vs the EXISTING slot - this is NOT accuracy.');
  console.log(`Sampled ${items.length} recipes`, perSlot, `(up to ${perClass} per slot, seed ${seed}).`);
  console.log(`Rough estimate ~${Math.ceil((items.length * 12) / 60)} min (12 s a call is a guess; the real time is printed as it runs).`);

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
    onProgress: (done, total, soFar) => {
      if (done === 1 || done % 5 === 0 || done === total) {
        const perCall = (Date.now() - started) / done;
        const last = soFar[soFar.length - 1];
        console.log(`  ${done}/${total} done, ${(perCall / 1000).toFixed(1)} s a call so far, ~${Math.ceil(((total - done) * perCall) / 60000)} min left${done === 1 && last.error ? ` (first call failed: ${last.error})` : ''}`);
      }
    },
  });
  if (aborted) console.log(`\nStopped early: ${aborted}`);

  const answeredCount = results.filter((r) => r.slotProbs).length;
  const agreement = slotAgreement(results);
  const yesRates = slotYesRates(results);
  const lat = summarizeLatencies(results.map((r) => r.latencyMs));

  console.log('\n=== Laya slot answers vs EXISTING slot (NOT accuracy) ===');
  console.log(`Answered ${answeredCount} of ${results.length}; errors/timeouts ${results.length - answeredCount}.`);
  console.log(`LATENCY of the eight-question request: mean ${lat.mean} ms, p50 ${lat.p50}, p95 ${lat.p95}, p99 ${lat.p99}  (the old two-question call was ~6300 ms mean)`);
  console.log(`Laya rates the existing slot suitable (>= ${agreement.threshold}): ${agreement.ratedSuitable}/${agreement.n} = ${pct(agreement.suitableRate)}`);
  console.log(`Laya's single top pick IS the existing slot: ${agreement.topIsSource}/${agreement.n} = ${pct(agreement.topRate)}   (pure chance among ${SLOT_KEYS.length} slots: ${pct(1 / SLOT_KEYS.length)})`);
  console.log(`Slots Laya says yes to, per recipe: mean ${agreement.meanSlotsRatedSuitable} of ${agreement.maxSlots} (7 would mean "yes to everything": no discrimination)`);
  console.log('By existing slot (rated suitable / top pick):');
  for (const k of SLOT_KEYS) {
    const b = agreement.bySlot[k];
    if (b) console.log(`  ${slotName(k).padEnd(14)} ${b.ratedSuitable}/${b.n} = ${pct(b.suitableRate)}   top pick ${b.topIsSource}/${b.n} = ${pct(b.topRate)}`);
  }
  console.log('How often Laya says yes to each slot (overall):');
  for (const k of SLOT_KEYS) console.log(`  ${slotName(k).padEnd(14)} ${yesRates[k].yes}/${yesRates[k].n} = ${pct(yesRates[k].rate)}`);
  console.log('Existing slot -> Laya top pick:');
  for (const [k, v] of Object.entries(topPickConfusion(results)).sort((a, b) => b[1] - a[1]).slice(0, 14)) console.log(`  ${k}: ${v}`);
  console.log('Recipes where Laya does NOT rate the existing slot suitable (many may be fair - dishes fit several slots):');
  for (const d of notRatedSuitable(results, 12)) console.log(`  ${d.name}: existing ${d.source} (p ${Number(d.pSource).toFixed(2)}), Laya's top ${d.laysTop} (p ${Number(d.pTop).toFixed(2)})`);
  console.log('\nReminder: this is agreement with existing labels, NOT accuracy.');
  console.log('Neither is accuracy. Only the dietician-reviewed dataset measures that.');

  const outFile = path.resolve(args.out || path.join(__dirname, '..', 'tests', 'laya', 'results', `source-agreement-${new Date().toISOString().replace(/[:.]/g, '-')}.json`));
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify({ note: 'agreement with existing slot labels, NOT accuracy', perClass, seed, aborted, agreement, yesRates, latency: lat, results }, null, 2));
  console.log(`\nFull results: ${outFile}`);
})().catch((err) => {
  console.error('laya-source-agreement failed:', err.message);
  process.exit(1);
});
