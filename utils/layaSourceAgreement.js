/**
 * Logic for scripts/laya-source-agreement.js: a BLIND, sequential run of Laya's
 * per-slot questions over saved recipes, compared with each recipe's EXISTING
 * serving slot.
 *
 * This is NOT accuracy. The existing slot is just what someone filed the recipe
 * under; it is one slot that is acceptable, not the only one (a recipe can suit
 * several), so the fair question is "does Laya rate the existing slot
 * suitable?" - recall of one known-good slot. How many OTHER slots it also says
 * yes to shows whether it is discriminating at all (yes to everything would
 * score perfect recall). Real accuracy comes only from the dietician-reviewed
 * dataset (tests/laya/README.md). It also measures the per-call latency of the
 * eight-question request.
 *
 * Pure: the Laya call and the sleep are injected, so it is unit-tested without
 * a server. The recipe handed to `classify` carries NO servingTime.
 */

const { SLOT_KEYS, slotProbabilities, slotAnswerMode, topSlot } = require('./layaSlots');
const { rankMetrics } = require('./layaRank');

const BUSY = /HTTP 503/;
const YES_AT = 0.5;

/**
 * @param {Array<{id, name, sourceSlot, recipe}>} items  recipe has no servingTime
 * @param {Function} classify  ({ recipe }) => layaDecisionService-style result
 * @param {Function} sleep     (ms) => Promise
 */
async function runSourceAgreement({ items, classify, sleep, retries = 3, retryDelayMs = 3000, maxConsecutiveFailures = 5, onProgress }) {
  const results = [];
  let consecutiveFailures = 0;
  let aborted = null;

  for (let i = 0; i < items.length; i += 1) {
    const it = items[i];
    let attempt = 0;
    let r;
    for (;;) {
      // eslint-disable-next-line no-await-in-loop
      r = await classify({ recipe: it.recipe });
      // Laya refuses (503) while another request is in flight - e.g. a real
      // shadow call. That is "busy", not "broken": wait and try again.
      if (!r.ok && BUSY.test(r.detail || '') && attempt < retries) {
        attempt += 1;
        // eslint-disable-next-line no-await-in-loop
        await sleep(retryDelayMs);
        continue;
      }
      break;
    }

    const probs = r.ok ? slotProbabilities(r.answers) : null;
    results.push({
      id: it.id,
      name: it.name,
      sourceSlot: it.sourceSlot,
      slotProbs: probs,
      slotMode: r.ok ? slotAnswerMode(r.answers) : null,
      topSlot: probs ? topSlot(probs) : null,
      latencyMs: r.ok ? r.latencyMs : null,
      error: r.ok ? null : `${r.reason}${r.detail ? `: ${r.detail}` : ''}`,
      retries: attempt,
    });

    consecutiveFailures = r.ok ? 0 : consecutiveFailures + 1;
    if (onProgress) onProgress(i + 1, items.length, results);
    if (consecutiveFailures >= maxConsecutiveFailures) {
      aborted = `${consecutiveFailures} calls in a row failed (last: ${results[results.length - 1].error}) - Laya looks down, stopping`;
      break;
    }
  }
  return { results, aborted };
}

const rate = (a, b) => (b ? Number((a / b).toFixed(3)) : null);
const answered = (results) => results.filter((r) => r.slotProbs && r.topSlot);

/**
 * Overall and per existing slot: how often Laya rates the existing slot
 * suitable (>= 0.5), how often its top pick IS the existing slot, and how many
 * slots it says yes to per recipe.
 */
function slotAgreement(results, threshold = YES_AT) {
  const rows = answered(results).filter((r) => r.sourceSlot);
  const bySlot = {};
  let ratedSuitable = 0;
  let topIsSource = 0;
  let yesTotal = 0;
  for (const r of rows) {
    const p = r.slotProbs[r.sourceSlot];
    const yes = typeof p === 'number' && p >= threshold;
    const top = r.topSlot === r.sourceSlot;
    if (yes) ratedSuitable += 1;
    if (top) topIsSource += 1;
    yesTotal += SLOT_KEYS.filter((k) => typeof r.slotProbs[k] === 'number' && r.slotProbs[k] >= threshold).length;
    const b = (bySlot[r.sourceSlot] = bySlot[r.sourceSlot] || { n: 0, ratedSuitable: 0, topIsSource: 0 });
    b.n += 1;
    if (yes) b.ratedSuitable += 1;
    if (top) b.topIsSource += 1;
  }
  for (const b of Object.values(bySlot)) {
    b.suitableRate = rate(b.ratedSuitable, b.n);
    b.topRate = rate(b.topIsSource, b.n);
  }
  return {
    n: rows.length,
    threshold,
    ratedSuitable,
    suitableRate: rate(ratedSuitable, rows.length),
    topIsSource,
    topRate: rate(topIsSource, rows.length),
    meanSlotsRatedSuitable: rows.length ? Number((yesTotal / rows.length).toFixed(2)) : null,
    // answering yes to every slot would score 100% suitable; a mean near 7 means no discrimination
    maxSlots: SLOT_KEYS.length,
    bySlot,
  };
}

/** How often Laya says yes to each slot, across all answered recipes. */
function slotYesRates(results, threshold = YES_AT) {
  const rows = answered(results);
  const out = {};
  for (const k of SLOT_KEYS) {
    const yes = rows.filter((r) => typeof r.slotProbs[k] === 'number' && r.slotProbs[k] >= threshold).length;
    out[k] = { yes, n: rows.length, rate: rate(yes, rows.length) };
  }
  return out;
}

/** Existing-slot -> Laya's top pick counts, e.g. { "dinner -> lunch": 9 }. */
function topPickConfusion(results) {
  const out = {};
  for (const r of answered(results)) {
    if (!r.sourceSlot) continue;
    const key = `${r.sourceSlot} -> ${r.topSlot}`;
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}

/** The first `limit` recipes where Laya does NOT rate the existing slot suitable. */
function notRatedSuitable(results, limit = 15, threshold = YES_AT) {
  return answered(results)
    .filter((r) => r.sourceSlot && !(r.slotProbs[r.sourceSlot] >= threshold))
    .slice(0, limit)
    .map((r) => ({
      name: r.name,
      source: r.sourceSlot,
      pSource: r.slotProbs[r.sourceSlot],
      laysTop: r.topSlot,
      pTop: r.slotProbs[r.topSlot],
    }));
}

/**
 * Threshold-free summary for either answer form: where the EXISTING slot ranks
 * among the seven scores (chance: mean rank 4, top-1 14%), per-slot AUC, and
 * top-1 after removing each slot's own bias. See utils/layaRank.js.
 */
function rankSummary(results) {
  return rankMetrics(
    answered(results)
      .filter((r) => r.sourceSlot)
      .map((r) => ({ accepted: [r.sourceSlot], probs: r.slotProbs }))
  );
}

module.exports = { runSourceAgreement, slotAgreement, slotYesRates, topPickConfusion, notRatedSuitable, rankSummary };
