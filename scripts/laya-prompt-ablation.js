/**
 * Prompt ablation: what is the CHEAPEST prompt that keeps its accuracy?
 *
 * Laya runs on our own VM, so its cost is compute, and compute is proportional
 * to input tokens (~29 ms a token on the production VM). The tokens are mostly
 * the question text, so this runs the same recipes through several stripped-down
 * versions of the slot question (utils/layaPrompts.js: with/without descriptions,
 * with/without the protein question, fewer ingredients...) and reports, per
 * variant: tokens per call (from Laya's own usage count), latency, and the
 * threshold-free rank metrics (utils/layaRank.js) next to a bag-of-words
 * baseline. The recommendation is the cheapest variant whose macro AUC is within
 * --tolerance (default 0.03) of the best.
 *
 * !! Accuracy here is AGREEMENT WITH EXISTING SLOT LABELS, not accuracy. !!
 * It is an imperfect yardstick, but the SAME one for every variant on the SAME
 * recipes, which is what an ablation needs. Confirm a winner on dietician-reviewed
 * data (tests/laya/README.md) before relying on it. With ~70 recipes, differences
 * under ~0.04 AUC are within noise.
 *
 * Read-only: samples saved recipes (all seven slots, shuffled), no database
 * writes. It calls a real Laya one request at a time and keeps it busy for the
 * whole run (shadowing is off, so nothing competes): run it at a quiet time from
 * the backend container's Coolify Terminal.
 *
 * Usage:
 *   node scripts/laya-prompt-ablation.js --yes [--variants=current,no_protein,labels,...]
 *        [--per-class=10] [--seed=1] [--tolerance=0.03] [--timeout-ms=60000] [--out=<file>]
 *   node scripts/laya-prompt-ablation.js --dry-run          (sample, variants, time estimate)
 *   node scripts/laya-prompt-ablation.js --from=<saved results .json> [--tolerance=0.02]
 *
 * --variants defaults to all (see utils/layaPrompts.js). Run a subset to split a
 * long run: the estimate is printed first. Saved results live on the container's
 * disk and are lost on redeploy: copy the table out in the same session.
 */
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const { sampleStratified, shuffleSeeded } = require('../utils/layaEval');
const { SLOT_NAMES, slotKeyFromServingTime, slotName } = require('../utils/layaSlots');
const { rankMetrics } = require('../utils/layaRank');
const { leaveOneOut } = require('../utils/layaBaselines');
const { VARIANTS, VARIANT_IDS, variantById, buildRequest } = require('../utils/layaPrompts');
const { runSourceAgreement } = require('../utils/layaSourceAgreement');
const { summarizeVariant, compareVariants } = require('../utils/layaAblation');

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
const MS_PER_TOKEN_VM = 29; // measured on the production VM, 2026-10-05
const UNMEASURED_TOKENS = 200; // for a variant not yet measured, only for the time estimate

function report({ comparison, baseline, tolerance }) {
  console.log('\n=== Prompt ablation: tokens vs agreement with existing slot labels (NOT accuracy) ===');
  console.log('chance: mean rank 4.00, top-1 14%, top-2 29%, AUC 0.50\n');
  console.log(`${'variant'.padEnd(16)}${'tokens'.padStart(7)}${'ms/call'.padStart(9)}${'mean rank'.padStart(11)}${'top-1'.padStart(7)}${'top-2'.padStart(7)}${'AUC'.padStart(7)}   ${'vs current'.padEnd(26)} note`);
  for (const r of comparison.rows) {
    const vs = r.id === comparison.reference ? '(reference)' : `tokens ${r.dTokensPct == null ? 'n/a' : `${r.dTokensPct > 0 ? '+' : ''}${r.dTokensPct}%`}, AUC ${r.dAuc == null ? 'n/a' : `${r.dAuc >= 0 ? '+' : ''}${r.dAuc.toFixed(2)}`}`;
    const note = [r.recommended ? 'RECOMMENDED' : '', r.dominated ? 'dominated' : '', r.errors ? `${r.errors} errors` : ''].filter(Boolean).join(', ');
    console.log(`${r.id.padEnd(16)}${String(r.meanInputTokens == null ? 'n/a' : r.meanInputTokens).padStart(7)}${String(r.latency.mean == null ? 'n/a' : r.latency.mean).padStart(9)}${f2(r.meanRank).padStart(11)}${pct(r.top1).padStart(7)}${pct(r.top2).padStart(7)}${f2(r.macroAuc).padStart(7)}   ${vs.padEnd(26)} ${note}`);
  }
  if (baseline) {
    console.log(`${'(bag-of-words)'.padEnd(16)}${'-'.padStart(7)}${'-'.padStart(9)}${f2(baseline.meanBestAcceptedRank).padStart(11)}${pct(baseline.topK[1].rate).padStart(7)}${pct(baseline.topK[2].rate).padStart(7)}${f2(baseline.macroAuc).padStart(7)}   trained on the labels, no Laya   reference`);
  }

  const withProtein = comparison.rows.filter((r) => r.protein && r.protein.spearman != null);
  if (withProtein.length) {
    console.log('\nProtein tier vs the nutrition data (variants that ask it; rank-based):');
    for (const r of withProtein) {
      const p = r.protein;
      console.log(`  ${r.id.padEnd(16)} Spearman ${p.spearman}, AUC high-vs-low third ${p.aucHighVsLowThird}, tier = grams tertile ${pct(p.tierAgreement.rate)} (chance 33%), within-slot mean ${p.withinSlotSpearman.mean} (n=${p.n}; tokens ${r.meanInputTokens})`);
    }
    console.log('  (what the protein question adds vs what it costs: compare each with-protein variant to its no-protein twin above)');
  }

  console.log('');
  if (comparison.recommended) {
    const rec = comparison.rows.find((r) => r.id === comparison.recommended);
    console.log(`Cheapest variant within ${tolerance} AUC of the best (${comparison.bestAuc}): ${rec.id}  -  ${rec.meanInputTokens} tokens (${rec.dTokensPct}% vs current), AUC ${f2(rec.macroAuc)} (${rec.dAuc >= 0 ? '+' : ''}${rec.dAuc} vs current).`);
  } else {
    console.log('No variant could be recommended (missing AUC or token counts).');
  }
  console.log('Differences under ~0.04 AUC are within noise at this sample size. Agreement with existing labels, NOT accuracy:');
  console.log('confirm the winner on dietician-reviewed data before relying on it.');
}

function analyse(resultsByVariant, baseline, tolerance) {
  const summaries = {};
  for (const [id, results] of Object.entries(resultsByVariant)) summaries[id] = summarizeVariant(results);
  const comparison = compareVariants(summaries, { reference: 'current', tolerance });
  report({ comparison, baseline, tolerance });
  return comparison;
}

(async () => {
  const args = parseArgs(process.argv);
  const tolerance = Number(args.tolerance) || 0.03;

  // ---- re-analyse a saved run: no database, no Laya
  if (args.from) {
    const saved = JSON.parse(fs.readFileSync(path.resolve(args.from), 'utf8'));
    console.log(`Re-analysing ${Object.keys(saved.resultsByVariant || {}).length} variants from ${args.from} (no Laya, no database).`);
    analyse(saved.resultsByVariant || {}, saved.baseline || null, tolerance);
    return;
  }

  const mongoose = require('mongoose');
  const connectDB = require('../config/database');
  const config = require('../config/environment');
  const Recipe = require('../models/Recipe');
  const { askLaya } = require('../services/layaDecisionService');

  const perClass = Number(args['per-class']) || 10;
  const seed = Number(args.seed) || 1;
  const wanted = args.variants && args.variants !== true ? String(args.variants).split(',').map((v) => v.trim()).filter(Boolean) : VARIANT_IDS;
  const unknown = wanted.filter((v) => !variantById(v));
  if (unknown.length) {
    console.error(`Unknown variant(s): ${unknown.join(', ')}. Known: ${VARIANT_IDS.join(', ')}`);
    process.exit(1);
  }
  // 'current' is the reference every row is compared against, so it always runs.
  const ids = wanted.includes('current') ? wanted : ['current', ...wanted];
  config.laya.timeoutMs = Number(args['timeout-ms'] || 60000);

  if (!config.laya.enabled || !config.laya.baseUrl || !config.laya.apiKey) {
    console.error('LAYA_ENABLED=true plus LAYA_BASE_URL and LAYA_API_KEY must be set (run this in the backend container).');
    process.exit(1);
  }

  await connectDB();
  const docs = await Recipe.find({ servingTime: { $in: SLOT_NAMES }, category: { $ne: 'Supplements' } })
    .select('name cuisine category servingTime ingredients.name nutritionPerServing.protein')
    .lean();
  await mongoose.disconnect(); // nothing more is read from the database

  const recipes = docs.map((r) => ({
    id: String(r._id),
    name: r.name,
    cuisine: r.cuisine || null,
    category: r.category || null,
    slot: slotKeyFromServingTime(r.servingTime),
    ingredients: (r.ingredients || []).map((i) => ({ name: i.name })),
    proteinG: typeof r.nutritionPerServing?.protein === 'number' ? r.nutritionPerServing.protein : null,
  }));
  const sample = shuffleSeeded(sampleStratified(recipes, (r) => r.slot, perClass, seed), seed + 1);
  const items = sample.map((r) => ({
    id: r.id,
    name: r.name,
    sourceSlot: r.slot,
    proteinG: r.proteinG,
    // The recipe given to Laya has NO servingTime; the source slot is kept beside it.
    recipe: { name: r.name, cuisine: r.cuisine, category: r.category, ingredients: r.ingredients },
  }));

  // Reference: a bag-of-words classifier trained on the labels, scored leave-one-out, on the same sample.
  const loo = leaveOneOut(recipes);
  const baseline = rankMetrics(sample.map((r) => ({ accepted: [r.slot], probs: loo[r.id].naiveBayes })));

  const perSlot = {};
  items.forEach((i) => { perSlot[slotName(i.sourceSlot)] = (perSlot[slotName(i.sourceSlot)] || 0) + 1; });
  console.log('Prompt ablation: tokens vs agreement with the EXISTING slot labels - this is NOT accuracy.');
  console.log(`Sampled ${items.length} recipes`, perSlot, `(up to ${perClass} per slot, seed ${seed}).`);
  let totalSeconds = 0;
  console.log('Variants and a rough time estimate (tokens x ~29 ms on the VM):');
  for (const id of ids) {
    const v = variantById(id);
    const tokens = v.approxInputTokens || UNMEASURED_TOKENS;
    const secs = (tokens * MS_PER_TOKEN_VM * items.length) / 1000;
    totalSeconds += secs;
    console.log(`  ${id.padEnd(16)} ~${String(tokens).padStart(3)} tokens${v.approxInputTokens ? '' : ' (not yet measured)'}  ~${Math.ceil(secs / 60)} min   ${v.label}`);
  }
  console.log(`Estimated total ~${Math.ceil(totalSeconds / 60)} min. Run a subset with --variants=... to split it.`);

  if (args['dry-run']) {
    console.log('--dry-run: not calling Laya.');
    return;
  }
  if (!args.yes) {
    console.error('Refusing to run without --yes: this keeps Laya busy for the whole run. Run it at a quiet time.');
    process.exit(1);
  }

  const resultsByVariant = {};
  for (const id of ids) {
    const started = Date.now();
    console.log(`\n--- ${id} ---`);
    const { results, aborted } = await runSourceAgreement({
      items,
      classify: ({ recipe }) => askLaya(buildRequest(id, recipe)),
      sleep,
      onProgress: (done, total) => {
        if (done === 1 || done % 10 === 0 || done === total) {
          const perCall = (Date.now() - started) / done;
          console.log(`  ${done}/${total}, ${(perCall / 1000).toFixed(1)} s a call, ~${Math.ceil(((total - done) * perCall) / 60000)} min left for this variant`);
        }
      },
    });
    resultsByVariant[id] = results;
    if (aborted) {
      console.log(`Stopped early: ${aborted}`);
      break;
    }
  }

  analyse(resultsByVariant, baseline, tolerance);

  const outFile = path.resolve(args.out || path.join(__dirname, '..', 'tests', 'laya', 'results', `prompt-ablation-${new Date().toISOString().replace(/[:.]/g, '-')}.json`));
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify({ note: 'agreement with existing slot labels, NOT accuracy', perClass, seed, variants: ids, baseline, resultsByVariant }, null, 2));
  console.log(`\nFull results: ${outFile}`);
  console.log(`Re-analyse later (e.g. a different tolerance) with: node scripts/laya-prompt-ablation.js --from=${outFile}`);
})().catch((err) => {
  console.error('laya-prompt-ablation failed:', err.message);
  process.exit(1);
});

// Referenced so the list of variants is visible in --help-style grep of this file.
void VARIANTS;
