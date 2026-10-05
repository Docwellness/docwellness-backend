/**
 * Logic for scripts/laya-source-agreement.js: a BLIND, sequential run of Laya's
 * meal-type question over saved recipes, scored against each recipe's EXISTING
 * serving slot.
 *
 * This is NOT accuracy. The existing slot is just what someone filed the recipe
 * under; it can be wrong, and many dishes fit several meals. It is a cheap
 * smoke test - "is Laya's meal-type judgement anywhere near the existing labels
 * once it can no longer read them?" - to run before spending dietician time.
 * Real accuracy comes only from the dietician-reviewed dataset
 * (tests/laya/README.md).
 *
 * Pure: the Laya call and the sleep are injected, so it is unit-tested without
 * a server. The recipe handed to `classify` carries NO servingTime.
 */

const BUSY = /HTTP 503/;

/**
 * @param {Array<{id, name, sourceMeal, recipe}>} items  recipe has no servingTime
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

    const answer = r.ok ? r.answers && r.answers.meal_type_fit : null;
    results.push({
      id: it.id,
      name: it.name,
      expected: { meal_type: it.sourceMeal },
      predicted: r.ok ? { meal_type: (answer && answer.choice) || null } : null,
      confidence: r.ok && answer && typeof answer.confidence === 'number' ? answer.confidence : null,
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

/** { slot: { n, agree, rate } } over results Laya actually answered. */
function perClassAgreement(results) {
  const out = {};
  for (const r of results) {
    if (!r.predicted || !r.predicted.meal_type) continue;
    const slot = r.expected.meal_type;
    const c = (out[slot] = out[slot] || { n: 0, agree: 0 });
    c.n += 1;
    if (r.predicted.meal_type === slot) c.agree += 1;
  }
  for (const c of Object.values(out)) c.rate = c.n ? Number((c.agree / c.n).toFixed(3)) : null;
  return out;
}

/** The first `limit` rows where Laya's answer differs from the existing slot. */
function disagreements(results, limit = 15) {
  return results
    .filter((r) => r.predicted && r.predicted.meal_type && r.predicted.meal_type !== r.expected.meal_type)
    .slice(0, limit)
    .map((r) => ({ name: r.name, source: r.expected.meal_type, laya: r.predicted.meal_type, confidence: r.confidence }));
}

module.exports = { runSourceAgreement, perClassAgreement, disagreements };
