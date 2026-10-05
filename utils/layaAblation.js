/**
 * Analysis for scripts/laya-prompt-ablation.js: per-variant summaries (tokens,
 * latency, rank metrics, protein check) and the comparison that answers "what
 * is the cheapest prompt that keeps its accuracy?".
 *
 * Accuracy here is AGREEMENT WITH EXISTING SLOT LABELS (not accuracy; see
 * utils/layaSourceAgreement.js), used as a consistent yardstick across prompt
 * variants on the same recipes. The yardstick is imperfect, but it is the same
 * imperfect yardstick for every variant, which is what an ablation needs.
 * Pure functions, no I/O.
 */

const { summarizeLatencies } = require('./layaEval');
const { rankSummary } = require('./layaSourceAgreement');
const { proteinSummary } = require('./layaProtein');

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);

/** One variant's results (from runSourceAgreement) -> the numbers the table shows. */
function summarizeVariant(results) {
  const answered = results.filter((r) => r.slotProbs);
  const tokens = results.map((r) => r.inputTokens).filter((t) => typeof t === 'number');
  const rank = rankSummary(results);
  const hasProtein = answered.some((r) => r.protein && r.protein.probabilities);
  return {
    n: results.length,
    answered: answered.length,
    errors: results.length - answered.length,
    meanInputTokens: tokens.length ? Math.round(mean(tokens)) : null,
    latency: summarizeLatencies(results.map((r) => r.latencyMs)),
    meanRank: rank.meanBestAcceptedRank,
    top1: rank.topK && rank.topK[1] ? rank.topK[1].rate : null,
    top2: rank.topK && rank.topK[2] ? rank.topK[2].rate : null,
    top3: rank.topK && rank.topK[3] ? rank.topK[3].rate : null,
    macroAuc: rank.macroAuc,
    protein: hasProtein ? proteinSummary(results) : null,
  };
}

/**
 * Compare variants against a reference.
 *  - dTokensPct / dAuc / dTop1: change vs the reference (negative tokens = cheaper)
 *  - dominated: another variant is at least as accurate AND no more expensive, and
 *    strictly better on one of the two - a variant to ignore
 *  - recommended: the cheapest variant whose macro AUC is within `tolerance` of the
 *    best AUC seen ("good enough, then cheapest")
 * Variants with no AUC or no token count are listed but never recommended.
 */
function compareVariants(summaries, { reference = 'current', tolerance = 0.03 } = {}) {
  const ids = Object.keys(summaries);
  const ref = summaries[reference] || null;
  const usable = ids.filter((id) => summaries[id].macroAuc != null && summaries[id].meanInputTokens != null);
  const bestAuc = usable.length ? Math.max(...usable.map((id) => summaries[id].macroAuc)) : null;

  const dominated = new Set();
  for (const a of usable) {
    for (const b of usable) {
      if (a === b) continue;
      const A = summaries[a];
      const B = summaries[b];
      const noWorse = B.macroAuc >= A.macroAuc && B.meanInputTokens <= A.meanInputTokens;
      const strictlyBetter = B.macroAuc > A.macroAuc || B.meanInputTokens < A.meanInputTokens;
      if (noWorse && strictlyBetter) dominated.add(a);
    }
  }

  const good = usable.filter((id) => summaries[id].macroAuc >= bestAuc - tolerance);
  const recommended = good.length ? good.reduce((best, id) => (summaries[id].meanInputTokens < summaries[best].meanInputTokens ? id : best)) : null;

  const round = (v, d = 3) => (v == null ? null : Number(v.toFixed(d)));
  const rows = ids.map((id) => {
    const s = summaries[id];
    return {
      id,
      ...s,
      dTokensPct: ref && ref.meanInputTokens && s.meanInputTokens != null ? round(((s.meanInputTokens - ref.meanInputTokens) / ref.meanInputTokens) * 100, 0) : null,
      dAuc: ref && ref.macroAuc != null && s.macroAuc != null ? round(s.macroAuc - ref.macroAuc) : null,
      dTop1: ref && ref.top1 != null && s.top1 != null ? round(s.top1 - ref.top1) : null,
      dominated: dominated.has(id),
      recommended: id === recommended,
    };
  });
  return { reference, tolerance, bestAuc: round(bestAuc), recommended, rows };
}

module.exports = { summarizeVariant, compareVariants };
