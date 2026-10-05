/**
 * Scores Laya against the dietician-reviewed dataset in tests/laya/. Reads
 * <category>.json files, ignores any example that is not reviewed
 * (reviewed_by !== "dietician" or no `expected`), calls Laya through
 * services/layaDecisionService.js, and reports accuracy, confusion, mean
 * confidence when right vs wrong, latency, and errors per category.
 *
 * Makes NO database writes. It does call a real Laya server, so point it at
 * one you are happy to load (LAYA_BASE_URL/LAYA_API_KEY). Examples run one at
 * a time (sequential) so latency isn't distorted by self-inflicted load.
 *
 * Usage:
 *   LAYA_ENABLED=true LAYA_BASE_URL=http://... LAYA_API_KEY=... \
 *   node scripts/laya-eval-run.js [--category=recipe_classification|meal_type (serving slots)|
 *        diet_compatibility|preference_matching|review_gating|all]
 *        [--model=laya-typed-decisions] [--timeout-ms=20000]
 *        [--noul-threshold=0.5] [--dir=tests/laya] [--out=<file>]
 *
 * To compare checkpoints, run once per --model and compare the output files.
 * Laya's router may serve a different checkpoint than requested; the served
 * model is recorded per run.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const config = require('../config/environment');
const layaService = require('../services/layaDecisionService');
const { CATEGORIES, isReviewed, scoreResults, scoreSlots, DEFAULT_NOUL_THRESHOLD } = require('../utils/layaEval');
const { slotProbabilities, SLOT_KEYS, slotName } = require('../utils/layaSlots');

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
  const dir = path.resolve(args.dir || path.join(__dirname, '..', 'tests', 'laya'));
  const wanted = !args.category || args.category === 'all' ? Object.keys(CATEGORIES) : [args.category];
  const noulThreshold = args['noul-threshold'] ? Number(args['noul-threshold']) : DEFAULT_NOUL_THRESHOLD;

  if (args.model) config.laya.model = args.model;
  if (args['timeout-ms']) config.laya.timeoutMs = Number(args['timeout-ms']);
  if (!config.laya.enabled) {
    console.error(
      'LAYA_ENABLED is not true - nothing to evaluate against. Set LAYA_ENABLED=true plus LAYA_BASE_URL and LAYA_API_KEY.'
    );
    process.exit(1);
  }

  const report = {
    runAt: new Date().toISOString(),
    requestedModel: config.laya.model,
    servedModels: [],
    noulThreshold,
    categories: {},
  };
  const served = new Set();

  for (const name of wanted) {
    const cat = CATEGORIES[name];
    if (!cat) {
      console.error(`Unknown category "${name}". Known: ${Object.keys(CATEGORIES).join(', ')}`);
      process.exit(1);
    }
    const file = path.join(dir, `${name}.json`);
    if (!fs.existsSync(file)) {
      report.categories[name] = { status: 'no dataset file', file };
      console.log(`${name}: no dataset at ${file} - skipped (the dataset is a human deliverable).`);
      continue;
    }
    const all = JSON.parse(fs.readFileSync(file, 'utf8'));
    const reviewed = all.filter(isReviewed);
    if (!reviewed.length) {
      report.categories[name] = { status: 'no reviewed examples', total: all.length };
      console.log(`${name}: ${all.length} rows, 0 reviewed - skipped.`);
      continue;
    }

    const results = [];
    for (const ex of reviewed) {
      // eslint-disable-next-line no-await-in-loop
      const r = await layaService[cat.service](cat.args(ex.input));
      if (r.ok && r.model) served.add(r.model);
      // The multi-label slot answers are scored separately (scoreSlots), so the
      // single-valued fields are scored from `expected` minus suitable_slots.
      const { suitable_slots: expectedSlots, ...singleValued } = ex.expected || {};
      results.push({
        expected: singleValued,
        predicted: r.ok ? cat.extract(r.answers, { noulThreshold }) : null,
        confidence: r.ok ? cat.confidence(r.answers) : null,
        latencyMs: r.ok ? r.latencyMs : null,
        error: r.ok ? null : `${r.reason}${r.detail ? `: ${r.detail}` : ''}`,
        expectedSlots: cat.slots ? expectedSlots || null : null,
        slotProbs: cat.slots && r.ok ? slotProbabilities(r.answers) : null,
      });
    }
    const scored = scoreResults(results);
    const slotScore = cat.slots ? scoreSlots(results, { threshold: noulThreshold }) : null;
    report.categories[name] = {
      status: 'scored',
      reviewedScored: reviewed.length,
      unreviewedSkipped: all.length - reviewed.length,
      ...scored,
      ...(slotScore ? { slots: slotScore } : {}),
    };
    const accs = Object.entries(scored.fields)
      .map(([f, s]) => `${f} ${s.correct}/${s.n}`)
      .join(', ');
    console.log(
      `${name}: ${reviewed.length} reviewed | ${accs || 'no single-valued fields'} | errors ${scored.errors} | p50 ${scored.latency.p50}ms p95 ${scored.latency.p95}ms`
    );
    if (slotScore && slotScore.examples) {
      const pc = (v) => (v == null ? 'n/a' : `${Math.round(v * 100)}%`);
      console.log(
        `  serving slots (yes at >= ${slotScore.threshold}): micro precision ${pc(slotScore.micro.precision)}, recall ${pc(slotScore.micro.recall)}, F1 ${pc(slotScore.micro.f1)}` +
          ` | top pick is an accepted slot ${pc(slotScore.topPickInExpectedSet)} | exact set ${pc(slotScore.exactSetMatch)}`
      );
      console.log(
        `  Laya says yes to ${slotScore.meanSlotsPredicted} slots per recipe; the reviewers accepted ${slotScore.meanSlotsExpected}. ` +
          `Answering yes to every slot would score precision ${pc(slotScore.baselineAllYesPrecision)} at recall 100%.`
      );
      for (const k of SLOT_KEYS) {
        const c = slotScore.slots[k];
        console.log(`    ${slotName(k).padEnd(14)} suits ${String(c.support).padStart(3)} | precision ${pc(c.precision).padStart(4)} recall ${pc(c.recall).padStart(4)} F1 ${pc(c.f1).padStart(4)}`);
      }
    }
  }

  report.servedModels = [...served];
  const outFile = path.resolve(
    args.out || path.join(dir, 'results', `eval-${report.runAt.replace(/[:.]/g, '-')}.json`)
  );
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
  console.log(`\nFull report: ${outFile}`);
  console.log('Accuracy thresholds for go/no-go are set by the team (docs/laya-evaluation.md), not by this script.');
})().catch((err) => {
  console.error('laya-eval-run failed:', err.message);
  process.exit(1);
});
