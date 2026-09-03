/**
 * Per-request timing + DB-query attribution - perf-observability-and-
 * validation task 2.1. Enters an AsyncLocalStorage context so the MongoDB
 * command-monitoring listeners (config/database.js) can attribute each
 * command to the request that issued it, times the request with a
 * monotonic clock, and on completion feeds utils/requestMetrics' rolling
 * per-route aggregate (read back at GET /api/internal/metrics).
 *
 * Purely observational: it never touches the request or response body and
 * never fails a request.
 */

const metrics = require('../utils/requestMetrics');

/** Stable per-endpoint key: the matched route pattern, not the concrete URL. */
function routeKey(req) {
  if (!req.route) return '(unmatched)';
  const base = req.baseUrl || '';
  const p = req.route.path;
  let pattern;
  if (typeof p === 'string') pattern = p;
  else if (Array.isArray(p)) pattern = p.map(String).join('|');
  else pattern = req.path; // regex route - fall back to the concrete path
  const full = `${base}${pattern}`.replace(/\/{2,}/g, '/');
  return full || '/';
}

function requestMetrics(req, res, next) {
  const start = process.hrtime.bigint();
  const store = metrics.newRequestStore();
  let recorded = false;
  const finish = () => {
    if (recorded) return;
    recorded = true;
    try {
      const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
      metrics.recordRequest({
        route: routeKey(req),
        method: req.method,
        status: res.statusCode,
        durationMs,
        dbCount: store.dbCount,
        dbMs: store.dbMs,
      });
    } catch {
      /* metrics must never break a request */
    }
  };
  res.on('finish', finish);
  res.on('close', finish); // client hangup before finish

  metrics.runInRequestContext(store, () => next());
}

module.exports = requestMetrics;
