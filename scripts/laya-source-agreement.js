/**
 * Smoke test: can Laya tell which serving slot a recipe belongs to, now that it
 * cannot see the recipe's existing slot? Also measures the per-call latency.
 *
 * !! This is agreement with existing labels, NOT accuracy. !!
 * The existing slot is just how someone filed the recipe: it can be wrong, and
 * a recipe can suit several slots, so it is ONE acceptable slot, not the only
 * one. Use this to decide whether the slot question is worth a dietician's
 * time, not as a result. Real accuracy needs the dietician-reviewed dataset
 * (tests/laya/README.md).
 *
 * The main result is threshold-free (utils/layaRank.js): where the existing
 * slot ranks among the seven scores (chance: mean rank 4.0, top-1 14%, top-2
 * 29%), the per-slot AUC (0.5 = no signal), and top-1 after removing each
 * slot's own bias. Thresholded yes/no numbers are shown only for the seven
 * yes/no questions ('noul'), where they mean something.
 *
 * Read-only: samples saved recipes (stratified by slot across all seven,
 * shuffled), makes NO database writes. It calls a real Laya one request at a
 * time, so it keeps Laya busy for the whole run: run it at a quiet time, from
 * the backend container's Coolify Terminal (the only place both the database
 * and Laya are reachable).
 *
 * Usage:
 *   node scripts/laya-source-agreement.js --yes [--slot-mode=choice|noul]
 *        [--per-class=10] [--seed=1] [--timeout-ms=60000] [--out=<file>] [--dry-run]
 *   node scripts/laya-source-agreement.js --from=<saved results .json>
 *
 * --slot-mode picks how the slots are asked: 'choice' (default, ONE 7-option
 * question, a probability per slot, ~1/4 of the cost) or 'noul' (seven yes/no
 * questions). Run both on the same sample (same --seed) to compare them.
 * --from re-analyses a results file saved by an earlier run, without touching
 * the database or Laya. --dry-run shows the sample size and exits. A request
 * Laya refuses (HTTP 503) is retried, and the run stops by itself if 5 calls in
 * a row fail.
 */
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const { sampleStratified, shuffleSeeded, summarizeLatencies } = require('../utils/layaEval');
const { proteinSummary } = require('../utils/layaProtein');
const { SLOT_KEYS, SLOT_NAMES, slotKeyFromServingTime, slotName } = require('../utils/layaSlots');
const {
  runSourceAgreement, slotAgreement, slotYesRates, topPickConfusion, notRatedSuitable, rankSummary,
} = require('../utils/layaSourceAgreement');

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

function report({ results, mode, aborted }) {
  const answeredCount = results.filter((r) => r.slotProbs).length;
  const lat = summarizeLatencies(results.map((r) => r.latencyMs));
  const rank = rankSummary(results);

  console.log('\n=== Laya slot scores vs EXISTING slot (NOT accuracy) ===');
  console.log(`Answer form: ${mode === 'noul' ? 'seven yes/no questions' : 'one 7-option question'}. Answered ${answeredCount} of ${results.length}; errors/timeouts ${results.length - answeredCount}.${aborted ? ' (stopped early)' : ''}`);
  console.log(`LATENCY per call: mean ${lat.mean} ms, p50 ${lat.p50}, p95 ${lat.p95}, p99 ${lat.p99}   [old two-question call ~6300 ms; seven yes/no questions ~28800 ms]`);

  console.log('\n-- Threshold-free (read these) --');
  console.log(`Existing slot's rank among the 7 scores: mean ${rank.meanBestAcceptedRank} (chance ${rank.chanceMeanBestRank}; 1.0 would be perfect)`);
  for (const k of [1, 2, 3]) {
    const t = rank.topK[k];
    console.log(`Existing slot in Laya's top ${k}: ${t.hit}/${rank.n} = ${pct(t.rate)}   (chance ${pct(t.chance)})`);
  }
  console.log(`Top-1 after removing each slot's own bias: ${rank.biasCorrectedTop1.hit}/${rank.biasCorrectedTop1.n} = ${pct(rank.biasCorrectedTop1.rate)}   (chance ${pct(rank.biasCorrectedTop1.chance)})`);
  console.log('Per-slot AUC (do recipes filed under the slot score higher for it than the others do? 0.5 = no signal, 1.0 = perfect):');
  for (const k of SLOT_KEYS) {
    const a = rank.aucBySlot[k];
    console.log(`  ${slotName(k).padEnd(14)} AUC ${a.auc == null ? 'n/a' : a.auc.toFixed(2)}   (${a.positives} filed under it, ${a.negatives} others)`);
  }
  console.log(`Macro-average AUC: ${rank.macroAuc == null ? 'n/a' : rank.macroAuc.toFixed(2)}`);

  // Laya's protein_level vs the exact protein per serving in the nutrition data. No human labels,
  // no gram threshold: rank-based. (Not a reason to use Laya for nutrition - the plan keeps that exact.)
  const prot = proteinSummary(results);
  console.log("\n-- protein_level vs the nutrition data's protein per serving (rank-based) --");
  if (prot.spearman == null && prot.note) {
    console.log(`  ${prot.note} (n=${prot.n}; results with no protein answers or no grams are skipped)`);
  } else {
    console.log(`  recipes with both Laya's protein answer and grams: ${prot.n}`);
    console.log(`  Spearman rank correlation: ${prot.spearman}   (0 = none, 1 = perfect, negative = backwards)`);
    console.log(`  AUC, highest-protein third vs lowest third: ${prot.aucHighVsLowThird}   (0.5 = no signal)`);
    console.log(`  Laya's tier equals the grams tertile: ${prot.tierAgreement.agree}/${prot.tierAgreement.n} = ${pct(prot.tierAgreement.rate)}   (chance ${pct(prot.tierAgreement.chance)})`);
    console.log(`  Same correlation WITHIN each slot (controls for dish type), mean over ${prot.withinSlotSpearman.slots} slots: ${prot.withinSlotSpearman.mean}`);
    for (const [slot, b] of Object.entries(prot.withinSlotSpearman.bySlot)) console.log(`    ${slotName(slot).padEnd(14)} rho ${b.rho} (n=${b.n})`);
    console.log('  grams tertile -> Laya tier:');
    for (const [k, v] of Object.entries(prot.confusion).sort((a, b) => b[1] - a[1])) console.log(`    ${k}: ${v}`);
  }

  const agreement = slotAgreement(results);
  console.log('\nExisting slot -> Laya top pick:');
  for (const [k, v] of Object.entries(topPickConfusion(results)).sort((a, b) => b[1] - a[1]).slice(0, 14)) console.log(`  ${k}: ${v}`);

  if (mode === 'noul') {
    console.log('\n-- Thresholded yes/no view (only meaningful for the seven yes/no questions) --');
    console.log(`Laya rates the existing slot suitable (>= ${agreement.threshold}): ${agreement.ratedSuitable}/${agreement.n} = ${pct(agreement.suitableRate)}`);
    console.log(`Slots Laya says yes to, per recipe: mean ${agreement.meanSlotsRatedSuitable} of ${agreement.maxSlots} (7 = "yes to everything")`);
    const yes = slotYesRates(results);
    console.log('How often it says yes to each slot (overall):');
    for (const k of SLOT_KEYS) console.log(`  ${slotName(k).padEnd(14)} ${yes[k].yes}/${yes[k].n} = ${pct(yes[k].rate)}`);
    console.log('Recipes where it does NOT rate the existing slot suitable:');
    for (const d of notRatedSuitable(results, 10)) console.log(`  ${d.name}: existing ${d.source} (p ${Number(d.pSource).toFixed(2)}), top ${d.laysTop} (p ${Number(d.pTop).toFixed(2)})`);
  }

  console.log('\nHow to read this: rank/AUC near chance (4.0 / 0.5) = the scores do not tell the slots apart;');
  console.log('clearly better = worth a dietician review. Agreement with existing labels, NOT accuracy.');
  return { rank, lat, agreement };
}

(async () => {
  const args = parseArgs(process.argv);

  // ---- re-analyse a saved run: no database, no Laya
  if (args.from) {
    const saved = JSON.parse(fs.readFileSync(path.resolve(args.from), 'utf8'));
    const results = saved.results || [];
    const mode = (results.find((r) => r.slotMode) || {}).slotMode || saved.slotMode || 'noul';
    console.log(`Re-analysing ${results.length} saved results from ${args.from} (no Laya, no database).`);
    report({ results, mode, aborted: saved.aborted });
    return;
  }

  const mongoose = require('mongoose');
  const connectDB = require('../config/database');
  const config = require('../config/environment');
  const Recipe = require('../models/Recipe');
  const { classifyRecipe } = require('../services/layaDecisionService');

  const perClass = Number(args['per-class']) || 10;
  const seed = Number(args.seed) || 1;
  const slotMode = args['slot-mode'] === 'noul' ? 'noul' : 'choice';
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
    .select('name cuisine category servingTime ingredients.name nutritionPerServing.protein')
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
    proteinG: typeof r.nutritionPerServing?.protein === 'number' ? r.nutritionPerServing.protein : null,
    recipe: {
      name: r.name,
      cuisine: r.cuisine || null,
      category: r.category || null,
      ingredients: (r.ingredients || []).map((i) => ({ name: i.name })),
    },
  }));

  const perSlot = {};
  items.forEach((i) => { perSlot[slotName(i.sourceSlot)] = (perSlot[slotName(i.sourceSlot)] || 0) + 1; });
  console.log("Blind check of Laya's serving-slot scores vs the EXISTING slot - this is NOT accuracy.");
  console.log(`Sampled ${items.length} recipes`, perSlot, `(up to ${perClass} per slot, seed ${seed}). Slot form: ${slotMode}.`);
  const guess = slotMode === 'noul' ? 30 : 12;
  console.log(`Rough estimate ~${Math.ceil((items.length * guess) / 60)} min (${guess} s a call is a guess; the real time is printed as it runs).`);

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
    classify: ({ recipe }) => classifyRecipe({ recipe, slotMode }),
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

  const { rank, lat, agreement } = report({ results, mode: slotMode, aborted });

  const outFile = path.resolve(args.out || path.join(__dirname, '..', 'tests', 'laya', 'results', `source-agreement-${slotMode}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`));
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify({ note: 'agreement with existing slot labels, NOT accuracy', slotMode, perClass, seed, aborted, rank, agreement, latency: lat, results }, null, 2));
  console.log(`\nFull results: ${outFile}`);
  console.log(`Re-analyse later with: node scripts/laya-source-agreement.js --from=${outFile}`);
})().catch((err) => {
  console.error('laya-source-agreement failed:', err.message);
  process.exit(1);
});
