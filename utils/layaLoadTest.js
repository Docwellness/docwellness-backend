/**
 * Logic for scripts/laya-load-test.js (integration plan section 24): payload
 * building, a bounded-concurrency pool, outcome classification, per-stage
 * summaries, a backend-responsiveness probe, and the abort guards. Everything
 * here takes its I/O (the Laya call, the probe's request, the clock) as an
 * argument, so it is unit-tested without a Laya server or a network.
 */

const { summarizeLatencies } = require('./layaEval');

// ---- payloads ---------------------------------------------------------------

// Representative recipe shapes of different sizes. Real runs should prefer
// --recipes-file (e.g. a review sheet exported from the real recipe database)
// so payload sizes match production; these are only the fallback.
const FALLBACK_RECIPES = [
  { name: 'Masala Oats Upma', cuisine: 'Indian', category: 'Indian', servingTime: 'Breakfast', ingredients: ['oats', 'onion', 'green peas', 'carrot', 'mustard seeds', 'curry leaves'] },
  { name: 'Paneer Butter Masala', cuisine: 'North Indian', category: 'High Protein', servingTime: 'Dinner', ingredients: ['paneer', 'tomato', 'butter', 'cream', 'onion', 'garlic', 'ginger', 'cashew', 'garam masala', 'kasuri methi', 'red chilli powder', 'coriander powder', 'salt'] },
  { name: 'Vegetable Pulao with Raita', cuisine: 'Indian', category: 'Indian', servingTime: 'Lunch', ingredients: ['basmati rice', 'carrot', 'green peas', 'beans', 'cauliflower', 'onion', 'ghee', 'cumin', 'bay leaf', 'cardamom', 'clove', 'cinnamon', 'curd', 'cucumber', 'mint', 'salt', 'turmeric', 'green chilli', 'coriander leaves', 'lemon juice'] },
];

function toRecipe(raw) {
  // Accepts {name, ingredients:[string|{name}]} or a review-sheet row
  // ({ input: { recipe } }).
  const r = (raw && raw.input && raw.input.recipe) || raw;
  return {
    name: r.name,
    cuisine: r.cuisine || null,
    category: r.category || null,
    servingTime: r.servingTime || null,
    ingredients: (r.ingredients || []).map((i) => (typeof i === 'string' ? { name: i } : { name: i.name })),
  };
}

function loadRecipes(list) {
  const recipes = (list && list.length ? list : FALLBACK_RECIPES).map(toRecipe).filter((r) => r.name);
  if (!recipes.length) throw new Error('No usable recipes for the load test payloads');
  return recipes;
}

// The largest diet-plan review summary the app can actually produce
// (runDietPlanGeneration caps warnings at 10 x 200 chars) - ~2 KB.
function reviewSummary(i) {
  return {
    riskFlags: ['isMinor', 'highProteinForWeight', 'minorOnHighProteinPlan'],
    warningCount: 10,
    warnings: Array.from({ length: 10 }, (_, k) => `Week 1 day ${(i + k) % 7 + 1}: ${'calorie target mismatch '.repeat(8)}`.slice(0, 200)),
    attemptsUsed: 3,
    engine: 'ai',
  };
}

// "recipe:70,compat:20,review:10" -> a deterministic repeating schedule, so a
// run is reproducible and the mix is exact over every 10 requests.
function parseMix(spec = 'recipe:80,review:20') {
  const parts = spec.split(',').map((p) => p.trim()).filter(Boolean).map((p) => {
    const [kind, weight] = p.split(':');
    return { kind, weight: Number(weight) };
  });
  const known = ['recipe', 'compat', 'review'];
  for (const p of parts) {
    if (!known.includes(p.kind) || !Number.isFinite(p.weight) || p.weight <= 0) {
      throw new Error(`Bad --mix entry "${p.kind}:${p.weight}". Use ${known.join('|')}:<positive number>`);
    }
  }
  const total = parts.reduce((s, p) => s + p.weight, 0);
  // Weighted interleave (smoothest spread): repeatedly take the kind whose next
  // "due time" is earliest, so every window of requests resembles the mix.
  const buckets = parts.map((p) => ({ kind: p.kind, left: p.weight, step: total / p.weight, next: total / p.weight / 2 }));
  const out = [];
  for (let t = 0; t < total; t += 1) {
    const due = buckets.filter((b) => b.left > 0).sort((a, b) => a.next - b.next)[0];
    out.push(due.kind);
    due.left -= 1;
    due.next += due.step;
  }
  return out;
}

/**
 * The i-th request of a run: which layaDecisionService function to call and
 * its args. Same functions and arg shapes production uses, so the load test
 * exercises the real code path (timeouts and fail-soft included).
 */
function buildRequest(kind, i, recipes) {
  const recipe = recipes[i % recipes.length];
  if (kind === 'review') return { fn: 'requiresDieticianReview', args: { decisionSummary: reviewSummary(i) } };
  if (kind === 'compat') {
    return {
      fn: 'checkRecipeCompatibility',
      args: { recipe, userProfile: { currentEatingStyle: 'vegetarian', preferences: 'light dinners, low oil', cravings: 'spicy food' } },
    };
  }
  return { fn: 'classifyRecipe', args: { recipe } };
}

// ---- outcomes and pool ------------------------------------------------------

/** Turn a layaDecisionService result into one of ok | timeout | overload | error. */
function classifyOutcome(result) {
  if (result && result.ok) return { ok: true };
  const reason = result && result.reason;
  const detail = (result && result.detail) || '';
  if (reason === 'timeout') return { ok: false, kind: 'timeout', detail };
  // Laya answers 503 when it is past LAYA_MAX_CONCURRENT: it is shedding load
  // on purpose, which is different from being broken.
  if (/HTTP 503/.test(detail)) return { ok: false, kind: 'overload', detail };
  return { ok: false, kind: 'error', detail: detail || reason || 'unknown' };
}

/**
 * Run `total` tasks with at most `concurrency` in flight (closed loop: a new
 * request starts the moment one finishes). `task(i)` returns
 * { result, latencyMs }. Reports the peak in-flight actually reached, so a
 * test (and the report) can prove the requested concurrency was real.
 */
async function runPool({ total, concurrency, task }) {
  const outcomes = new Array(total);
  let next = 0;
  let inFlight = 0;
  let peak = 0;
  async function worker() {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= total) return;
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      try {
        // eslint-disable-next-line no-await-in-loop
        const { result, latencyMs } = await task(i);
        outcomes[i] = { ...classifyOutcome(result), latencyMs, layaLatencyMs: result && result.latencyMs };
      } catch (err) {
        outcomes[i] = { ok: false, kind: 'error', detail: err.message, latencyMs: null };
      } finally {
        inFlight -= 1;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, total) }, worker));
  return { outcomes, peakInFlight: peak };
}

const rate = (n, d) => (d ? Number((n / d).toFixed(3)) : 0);

function summarizeStage({ concurrency, outcomes, wallMs, peakInFlight }) {
  const n = outcomes.length;
  const ok = outcomes.filter((o) => o.ok);
  const count = (kind) => outcomes.filter((o) => !o.ok && o.kind === kind).length;
  return {
    concurrency,
    peakInFlight,
    requests: n,
    ok: ok.length,
    errorRate: rate(n - ok.length, n),
    timeoutRate: rate(count('timeout'), n),
    overloadRate: rate(count('overload'), n), // HTTP 503: Laya's own concurrency cap
    otherErrorRate: rate(count('error'), n),
    // Client-side wall latency of SUCCESSFUL calls (includes any queueing inside Laya).
    latencyMs: summarizeLatencies(ok.map((o) => o.latencyMs)),
    wallSeconds: Number((wallMs / 1000).toFixed(2)),
    throughputOkPerSec: wallMs ? Number((ok.length / (wallMs / 1000)).toFixed(2)) : 0,
    errorSamples: [...new Set(outcomes.filter((o) => !o.ok).map((o) => `${o.kind}: ${o.detail}`.slice(0, 160)))].slice(0, 3),
  };
}

// ---- backend responsiveness probe ------------------------------------------

/**
 * Repeatedly times `sample()` (a request to the backend's own health route)
 * until stop() is called. Used to measure how much Laya load slows the
 * backend that shares the VM: run once idle for a baseline, then during each
 * stage.
 */
function startProbe({ sample, intervalMs = 250 }) {
  const latencies = [];
  let failures = 0;
  let stopped = false;
  let timer;
  const loop = async () => {
    if (stopped) return;
    const t0 = Date.now();
    try {
      await sample();
      latencies.push(Date.now() - t0);
    } catch {
      failures += 1;
    }
    if (!stopped) timer = setTimeout(loop, intervalMs);
  };
  loop();
  return {
    async stop() {
      stopped = true;
      clearTimeout(timer);
      return { ...summarizeLatencies(latencies), failures };
    },
  };
}

/** Why the run should stop escalating, or null to continue. */
function shouldAbort(stage, { abortErrorRate = 0.5, abortBackendP95Ms = 2000, backend } = {}) {
  if (stage.errorRate >= abortErrorRate && stage.requests >= 10 && stage.ok === 0) {
    return `every request failed at concurrency ${stage.concurrency}`;
  }
  if (stage.otherErrorRate >= abortErrorRate) {
    return `${Math.round(stage.otherErrorRate * 100)}% non-overload errors at concurrency ${stage.concurrency} (Laya is failing, not just shedding load)`;
  }
  if (backend && backend.p95 != null && backend.p95 >= abortBackendP95Ms) {
    return `backend /health p95 reached ${backend.p95}ms at concurrency ${stage.concurrency} - stopping to protect the backend`;
  }
  if (backend && backend.failures > 0 && backend.n === 0) {
    return `backend /health stopped answering at concurrency ${stage.concurrency}`;
  }
  return null;
}

module.exports = {
  FALLBACK_RECIPES,
  loadRecipes,
  parseMix,
  buildRequest,
  classifyOutcome,
  runPool,
  summarizeStage,
  startProbe,
  shouldAbort,
};
