/**
 * In-process request + DB-query metrics - perf-observability-and-validation,
 * task 2.1.
 *
 * There is no metrics backend (Prometheus / Datadog) in this deployment, so
 * this keeps a rolling in-memory summary per route - request-count, latency
 * p50/p95/p99, and average DB query count/duration - and exposes it at
 * GET /api/internal/metrics (shared-secret guarded). On the persistent
 * Coolify process this accumulates meaningfully; on the Vercel dev
 * deployment each serverless instance has its own short-lived view (same
 * limitation as the in-memory rate-limiter fallback) - metrics are meant to
 * be read from prod.
 *
 * DB attribution uses AsyncLocalStorage: a per-request store is entered by
 * the metrics middleware, and the MongoDB driver's command-monitoring
 * events (wired in config/database.js) add to whatever store is current
 * when the command completes. Commands issued outside a request (cron
 * sweeps, startup) still count toward the global DB totals but aren't
 * attributed to a route.
 */

const { AsyncLocalStorage } = require('async_hooks');

const als = new AsyncLocalStorage();

const MAX_SAMPLES_PER_ROUTE = 500; // rolling window for percentiles
const startedAt = new Date().toISOString();

/** key `${METHOD} ${routePattern}` -> aggregate */
const routes = new Map();

const db = {
  totalCommands: 0,
  totalMs: 0,
  failed: 0,
  byCommand: Object.create(null), // find / aggregate / insert / update / delete / ...
};

/** Commands worth attributing - skips heartbeats / session admin chatter. */
const TRACKED_COMMANDS = new Set([
  'find',
  'aggregate',
  'count',
  'distinct',
  'getMore',
  'insert',
  'update',
  'delete',
  'findAndModify',
  'bulkWrite',
  'createIndexes',
  'listIndexes',
]);

function emptyRoute() {
  return {
    count: 0,
    statuses: Object.create(null),
    samples: [],
    dbCountSum: 0,
    dbMsSum: 0,
    maxDurationMs: 0,
  };
}

/** A fresh per-request DB-counter store. */
function newRequestStore() {
  return { dbCount: 0, dbMs: 0 };
}

/**
 * Run `fn` inside `store` as the current AsyncLocalStorage context, so
 * recordCommand() attributes DB commands to it. The caller keeps its own
 * reference to `store` and reads the totals off it directly once the
 * request finishes (rather than relying on the ALS context still being
 * active in a late `res` event).
 */
function runInRequestContext(store, fn) {
  return als.run(store, fn);
}

/** Called by the DB command-monitoring listener for every tracked command. */
function recordCommand(commandName, durationMs, ok) {
  db.totalCommands += 1;
  db.totalMs += durationMs;
  if (!ok) db.failed += 1;
  db.byCommand[commandName] = (db.byCommand[commandName] || 0) + 1;

  const store = als.getStore();
  if (store) {
    store.dbCount += 1;
    store.dbMs += durationMs;
  }
}

/** Called once per finished request by the metrics middleware. */
function recordRequest({ route, method, status, durationMs, dbCount, dbMs }) {
  const key = `${method} ${route}`;
  let r = routes.get(key);
  if (!r) {
    r = emptyRoute();
    routes.set(key, r);
  }
  r.count += 1;
  r.statuses[status] = (r.statuses[status] || 0) + 1;
  r.samples.push(durationMs);
  if (r.samples.length > MAX_SAMPLES_PER_ROUTE) r.samples.shift();
  r.dbCountSum += dbCount;
  r.dbMsSum += dbMs;
  if (durationMs > r.maxDurationMs) r.maxDurationMs = durationMs;
}

function percentile(sortedAsc, p) {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.ceil((p / 100) * sortedAsc.length) - 1);
  return sortedAsc[Math.max(0, idx)];
}

const round = (n, dp = 0) => {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
};

function snapshot() {
  const routeOut = {};
  for (const [key, r] of routes) {
    const sorted = [...r.samples].sort((a, b) => a - b);
    routeOut[key] = {
      count: r.count,
      p50Ms: round(percentile(sorted, 50), 1),
      p95Ms: round(percentile(sorted, 95), 1),
      p99Ms: round(percentile(sorted, 99), 1),
      maxMs: round(r.maxDurationMs, 1),
      avgDbQueries: round(r.count ? r.dbCountSum / r.count : 0, 2),
      avgDbMs: round(r.count ? r.dbMsSum / r.count : 0, 1),
      statuses: { ...r.statuses },
    };
  }
  return {
    since: startedAt,
    routeCount: routes.size,
    routes: routeOut,
    db: {
      totalCommands: db.totalCommands,
      totalMs: round(db.totalMs, 1),
      failed: db.failed,
      byCommand: { ...db.byCommand },
    },
  };
}

/** Test-only reset. */
function _reset() {
  routes.clear();
  db.totalCommands = 0;
  db.totalMs = 0;
  db.failed = 0;
  for (const k of Object.keys(db.byCommand)) delete db.byCommand[k];
}

module.exports = {
  newRequestStore,
  runInRequestContext,
  recordCommand,
  recordRequest,
  snapshot,
  TRACKED_COMMANDS,
  _reset,
};
