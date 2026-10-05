/**
 * Laya load test (integration plan section 24): 1 / 5 / 10 / 20 / 50
 * concurrent requests against a real Laya, using the same
 * services/layaDecisionService.js code path production uses, while probing
 * the backend's own /health to measure how much the load slows the backend.
 *
 * Makes NO database writes and sends no patient data (payloads are recipe
 * data and a synthetic review summary).
 *
 * !! This loads the machine Laya runs on. On the production VM Laya shares
 * 2 cores with the backend, so run it when traffic is low, and run it from
 * the backend container's Coolify Terminal (Laya is internal-only, so that
 * is the only place it is reachable from). It refuses to run without --yes.
 *
 * Usage (in the backend container, where LAYA_* and PORT already exist):
 *   node scripts/laya-load-test.js --yes
 *        [--levels=1,5,10,20,50] [--requests-per-level=<n>]   (default max(20, 5*level))
 *        [--mix=recipe:80,review:20]     kinds: recipe | compat | review
 *        [--recipes-file=<json>]         recipes, or a review sheet from
 *                                        scripts/laya-eval-export-review-sheet.js
 *        [--timeout-ms=15000] [--cooldown-ms=5000] [--baseline-ms=5000]
 *        [--probe-url=http://127.0.0.1:<PORT>/health]
 *        [--abort-backend-p95-ms=2000] [--abort-error-rate=0.5]
 *        [--out=<file>]
 *
 * Reading the result:
 *   - overloadRate is HTTP 503: Laya refusing work past LAYA_MAX_CONCURRENT.
 *     That is deliberate load shedding, not a crash - but in shadow mode it
 *     means dropped decisions, and in live mode it means fallbacks.
 *   - CPU and RAM of the Laya container are NOT visible from here. Watch the
 *     Laya resource's metrics in Coolify (or `docker stats` on the VM) during
 *     the run; each stage prints its UTC start/end so you can line them up.
 *   - It stops escalating on its own if Laya is failing outright, or the
 *     backend's /health p95 passes --abort-backend-p95-ms.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const config = require('../config/environment');
const layaService = require('../services/layaDecisionService');
const {
  loadRecipes,
  parseMix,
  buildRequest,
  runPool,
  summarizeStage,
  startProbe,
  shouldAbort,
} = require('../utils/layaLoadTest');

function parseArgs(argv) {
  const out = {};
  for (const a of argv.slice(2)) {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    if (m) out[m[1]] = m[2] === undefined ? true : m[2];
  }
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Best-effort snapshot of whatever Laya reports about itself (authenticated
// /health includes checkpoint and device state). Never fails the run.
async function layaHealth() {
  try {
    const res = await fetch(`${config.laya.baseUrl}/health`, {
      headers: { Authorization: `Bearer ${config.laya.apiKey}` },
      signal: AbortSignal.timeout(3000),
    });
    return (await res.text()).slice(0, 1500);
  } catch (err) {
    return `unavailable: ${err.message}`;
  }
}

(async () => {
  const args = parseArgs(process.argv);
  const levels = String(args.levels || '1,5,10,20,50').split(',').map(Number).filter((n) => n > 0);
  const mix = parseMix(args.mix);
  const probeUrl = args['probe-url'] || `http://127.0.0.1:${process.env.PORT || 5000}/health`;
  const cooldownMs = Number(args['cooldown-ms'] ?? 5000);
  const baselineMs = Number(args['baseline-ms'] ?? 5000);
  const abortBackendP95Ms = Number(args['abort-backend-p95-ms'] || 2000);
  const abortErrorRate = Number(args['abort-error-rate'] || 0.5);
  // The documented default is 15000 (what production uses). Do NOT inherit a
  // shorter LAYA_TIMEOUT_MS from the env: this test is meant to measure real
  // latency, and a too-short timeout just measures the timeout.
  const timeoutMs = Number(args['timeout-ms'] || 15000);
  config.laya.timeoutMs = timeoutMs;

  if (!config.laya.enabled || !config.laya.baseUrl || !config.laya.apiKey) {
    console.error('LAYA_ENABLED=true plus LAYA_BASE_URL and LAYA_API_KEY must be set (run this in the backend container).');
    process.exit(1);
  }
  const maxConcurrentNote =
    'Laya returns HTTP 503 past its LAYA_MAX_CONCURRENT; those show as overloadRate, not errors.';
  if (!args.yes) {
    console.error(
      [
        'Refusing to run without --yes. This sends real load to Laya at ' + config.laya.baseUrl + ':',
        `  levels ${levels.join(', ')}  | mix ${args.mix || 'recipe:80,review:20'}  | timeout ${config.laya.timeoutMs}ms`,
        '  It slows the shared VM while it runs. Run it at a quiet time.',
        '  ' + maxConcurrentNote,
        'Re-run with --yes to proceed.',
      ].join('\n')
    );
    process.exit(1);
  }

  const recipeInput = args['recipes-file'] ? JSON.parse(fs.readFileSync(path.resolve(args['recipes-file']), 'utf8')) : null;
  const recipes = loadRecipes(recipeInput);
  const sample = () => fetch(probeUrl, { signal: AbortSignal.timeout(5000) }).then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); });

  const report = {
    startedAt: new Date().toISOString(),
    layaBaseUrl: config.laya.baseUrl,
    requestedModel: config.laya.model,
    timeoutMs,
    mix: args.mix || 'recipe:80,review:20',
    recipePayloads: recipes.length,
    note: maxConcurrentNote,
    layaHealthBefore: await layaHealth(),
    backendBaseline: null,
    stages: [],
    stoppedEarly: null,
  };

  // Warm-up: a cold first call is far slower and would distort the first
  // stage. It uses a generous timeout so it actually completes (a warm-up
  // that times out warms nothing), and the run aborts if Laya never answers.
  console.log('Warming up (3 sequential calls, not counted)...');
  config.laya.timeoutMs = Math.max(timeoutMs, 90000);
  let warmOk = 0;
  for (let i = 0; i < 3; i += 1) {
    const { fn, args: a } = buildRequest('recipe', i, recipes);
    // eslint-disable-next-line no-await-in-loop
    const r = await layaService[fn](a);
    if (r.ok) warmOk += 1;
    else console.log(`  warm-up call ${i + 1} failed: ${r.reason}${r.detail ? ` (${r.detail})` : ''}`);
  }
  config.laya.timeoutMs = timeoutMs;
  if (!warmOk) {
    console.error('Laya answered none of the warm-up calls - check LAYA_BASE_URL/LAYA_API_KEY and that Laya is healthy. Not load testing a service that is not answering.');
    process.exit(1);
  }
  report.warmup = { ok: warmOk, of: 3 };

  console.log(`Measuring backend baseline at ${probeUrl} (idle, ${baselineMs}ms)...`);
  const base = startProbe({ sample });
  await sleep(baselineMs);
  report.backendBaseline = await base.stop();
  console.log('  backend /health idle:', JSON.stringify(report.backendBaseline));
  if (!report.backendBaseline.n) {
    console.error(`Could not reach the backend probe at ${probeUrl}. Pass --probe-url, or this run cannot measure backend impact.`);
    process.exit(1);
  }

  for (const concurrency of levels) {
    const total = Number(args['requests-per-level']) || Math.max(20, 5 * concurrency);
    const startedAt = new Date().toISOString();
    console.log(`\n== concurrency ${concurrency}: ${total} requests (start ${startedAt}) ==`);
    const probe = startProbe({ sample });
    const t0 = Date.now();
    const { outcomes, peakInFlight } = await runPool({
      total,
      concurrency,
      task: async (i) => {
        const { fn, args: a } = buildRequest(mix[i % mix.length], i, recipes);
        const start = Date.now();
        const result = await layaService[fn](a);
        return { result, latencyMs: Date.now() - start };
      },
    });
    const wallMs = Date.now() - t0;
    const backend = await probe.stop();
    const stage = { ...summarizeStage({ concurrency, outcomes, wallMs, peakInFlight }), startedAt, endedAt: new Date().toISOString(), backend };
    report.stages.push(stage);

    const l = stage.latencyMs;
    console.log(
      `  ok ${stage.ok}/${stage.requests} | errors ${stage.errorRate} (timeout ${stage.timeoutRate}, 503 ${stage.overloadRate}, other ${stage.otherErrorRate})` +
        ` | latency ms mean ${l.mean} p50 ${l.p50} p95 ${l.p95} p99 ${l.p99} | ${stage.throughputOkPerSec} ok/s`
    );
    console.log(`  backend /health during: p50 ${backend.p50} p95 ${backend.p95} (idle p95 ${report.backendBaseline.p95}) failures ${backend.failures}`);
    if (stage.errorSamples.length) console.log('  error samples:', stage.errorSamples.join(' | '));

    const reason = shouldAbort(stage, { abortErrorRate, abortBackendP95Ms, backend });
    if (reason) {
      report.stoppedEarly = reason;
      console.log(`\nStopping early: ${reason}`);
      break;
    }
    if (concurrency !== levels[levels.length - 1]) {
      // eslint-disable-next-line no-await-in-loop
      await sleep(cooldownMs);
    }
  }

  report.layaHealthAfter = await layaHealth();
  report.finishedAt = new Date().toISOString();
  const outFile = path.resolve(args.out || path.join(__dirname, '..', 'tests', 'laya', 'results', `load-${report.startedAt.replace(/[:.]/g, '-')}.json`));
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
  console.log(`\nFull report: ${outFile}`);
  console.log('Now read the Laya container CPU/RAM for each stage window from Coolify metrics - this script cannot see them.');
})().catch((err) => {
  console.error('laya-load-test failed:', err.message);
  process.exit(1);
});
