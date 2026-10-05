/**
 * Shadow-mode runner for Laya (see docs/laya-architecture.md, "Shadow mode").
 *
 * Runs a services/layaDecisionService.js call alongside an existing flow and
 * logs the answer to GenerationLog (laya* fields) so Laya's judgments can be
 * compared against real outcomes before anything trusts them. It must never
 * change what the user or dietician sees, so by construction:
 *   - it returns nothing and callers never await it (fire-and-forget);
 *   - nothing here is ever read back into a response, validation result or
 *     risk flag;
 *   - every failure (Laya down, timeout, Mongo write error, bad input) is
 *     swallowed - at most a console.warn.
 *
 * It only does anything when ALL of these hold: LAYA_ENABLED=true,
 * LAYA_MODE=shadow, and the call site's `surface` is listed in
 * LAYA_SHADOW_SURFACES (comma-separated). That last switch lets each
 * decision be shadowed independently, instead of one global on/off.
 *
 * Rows written here are distinguishable from ordinary generation rows by
 * layaMode === 'shadow' (generation rows leave it null) and carry layaSurface.
 */

const config = require('../config/environment');
const GenerationLog = require('../models/GenerationLog');

function surfaceEnabled(surface) {
  const { enabled, mode, shadowSurfaces } = config.laya;
  return Boolean(enabled) && mode === 'shadow' && Array.isArray(shadowSurfaces) && shadowSurfaces.includes(surface);
}

// Lowest calibrated confidence across answers, or null if none reported one.
function minConfidence(answers) {
  const values = Object.values(answers || {})
    .map((a) => a && a.confidence)
    .filter((c) => typeof c === 'number');
  return values.length ? Math.min(...values) : null;
}

// Laya serves ONE request at a time, and a client timeout does NOT cancel work
// it already started (measured on the production VM: ~5.6 s per call; with 3+
// requests queued, every one outlasts the timeout and the queue fills with
// abandoned work, so nothing completes until the load stops). So shadow calls
// are capped in flight: past the cap a call is SKIPPED and recorded, never
// queued behind Laya. Shadow data is best-effort; users are never affected.
let inFlight = 0;

function maxInFlight() {
  const n = Number(config.laya.shadowMaxInFlight);
  return Number.isFinite(n) && n > 0 ? n : 2;
}

function baseRow({ surface, kind, dieticianId, refId, inputHash, requestId }) {
  return {
    kind,
    dieticianId,
    refId: refId || null,
    inputHash: inputHash || null,
    // Backend request id (req.id, also the X-Request-Id response header), so a
    // shadow row can be matched to the request's log lines.
    requestId: requestId || null,
    // The checkpoint asked for; the one Laya actually served is in
    // layaDecisions.servedModel (its router can pick a different one).
    model: config.laya.model || null,
    layaMode: 'shadow',
    layaSurface: surface,
  };
}

async function recordSkipped(opts) {
  await GenerationLog.create({
    ...baseRow(opts),
    layaDecisions: { reference: opts.reference || null },
    layaError: { reason: 'skipped', detail: `shadow in-flight cap reached (${maxInFlight()})` },
    succeeded: false,
  });
}

async function recordShadow(opts) {
  const { reference, call } = opts;
  let result;
  try {
    result = await call();
  } finally {
    // The cap is about concurrent work on Laya, so release it as soon as the
    // call returns - not after the database write below.
    inFlight -= 1;
  }
  await GenerationLog.create({
    ...baseRow(opts),
    // Laya's answers plus whatever the existing flow decided for the same
    // question ("reference"), so the two can be compared offline. Decision
    // metadata only - never the request text, never PII/PHI.
    layaDecisions: result.ok
      ? { answers: result.answers, servedModel: result.model || null, reference: reference || null }
      : { reference: reference || null },
    layaLatencyMs: result.ok ? result.latencyMs : null,
    layaConfidence: result.ok ? minConfidence(result.answers) : null,
    layaTimedOut: !result.ok && result.reason === 'timeout',
    layaError: result.ok ? null : { reason: result.reason, detail: String(result.detail || '').slice(0, 300) || null },
    succeeded: Boolean(result.ok),
  });
}

/**
 * @param {object}   opts
 * @param {string}   opts.surface   which decision this is, e.g. 'recipe_classification'
 * @param {string}   opts.kind      GenerationLog.kind of the flow being shadowed
 * @param {string}  [opts.requestId] req.id of the request being shadowed
 * @param {Function} opts.call      () => a layaDecisionService call (resolves, never throws)
 * @param {object}  [opts.reference] what the existing flow decided, for later comparison
 * @returns {void}  deliberately - callers must not depend on the outcome
 */
function runShadow(opts) {
  try {
    if (!opts || !surfaceEnabled(opts.surface)) return;
    if (inFlight >= maxInFlight()) {
      recordSkipped(opts).catch((err) => {
        console.warn(`[laya-shadow] ${opts.surface} skip-record failed:`, err && err.message);
      });
      return;
    }
    inFlight += 1; // released in recordShadow's finally
    recordShadow(opts).catch((err) => {
      console.warn(`[laya-shadow] ${opts.surface} failed:`, err && err.message);
    });
  } catch (err) {
    console.warn('[laya-shadow] unexpected error:', err && err.message);
  }
}

// Test seam: the counter is module state.
function _inFlightForTests() {
  return inFlight;
}

module.exports = { runShadow, surfaceEnabled, _inFlightForTests };
