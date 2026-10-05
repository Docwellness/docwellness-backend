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

async function recordShadow({ surface, kind, dieticianId, refId, inputHash, requestId, reference, call }) {
  const result = await call();
  await GenerationLog.create({
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
    recordShadow(opts).catch((err) => {
      console.warn(`[laya-shadow] ${opts.surface} failed:`, err && err.message);
    });
  } catch (err) {
    console.warn('[laya-shadow] unexpected error:', err && err.message);
  }
}

module.exports = { runShadow, surfaceEnabled };
