/**
 * Threshold-free ("rank") metrics for Laya's serving-slot scores.
 *
 * Thresholding a yes/no probability at 0.5 is fragile when the probabilities
 * cluster near 0.5 and carry a per-slot bias (measured 2026-10-05: Laya said
 * yes to Morning Drink 86% of the time and to Breakfast 46%, whatever the
 * recipe). These metrics only use the ORDER of the seven scores, so they ask
 * the question that matters: do the slots a recipe really suits score higher
 * than the ones it doesn't?
 *
 *  - rank of the best accepted slot, vs what random ranking would give
 *  - top-1 / top-2 / top-3 hit rate, vs the exact chance rate for those sets
 *  - per-slot AUC (recipes that suit slot S vs those that don't; 0.5 = no
 *    signal, 1.0 = perfect), and its macro average
 *  - top-1 after removing each slot's own bias (z-score per slot), which
 *    separates "Laya likes this slot for everything" from "Laya can tell"
 *
 * Pure functions, no I/O. An item is { accepted: [slot keys], probs: { key: p } }.
 */

const { SLOT_KEYS } = require('./layaSlots');

const N = SLOT_KEYS.length;

/** C(n, k) for small integers. */
function choose(n, k) {
  if (k < 0 || k > n) return 0;
  let r = 1;
  for (let i = 1; i <= k; i += 1) r = (r * (n - k + i)) / i;
  return Math.round(r);
}

/** Probability that a RANDOM top-k contains at least one of m accepted slots out of n. */
function chanceTopK(m, k, n = N) {
  if (m <= 0) return null;
  if (m >= n) return 1;
  return 1 - choose(n - m, k) / choose(n, k);
}

/** Expected rank (1 = best) of the best of m accepted slots under a random ordering of n. */
function chanceBestRank(m, n = N) {
  return m > 0 ? (n + 1) / (m + 1) : null;
}

/** 1-based rank of `key` by descending probability; ties share their average rank. Null if unscored. */
function rankOf(probs, key) {
  const p = probs && probs[key];
  if (typeof p !== 'number') return null;
  let better = 0;
  let equal = 0;
  for (const k of SLOT_KEYS) {
    const q = probs[k];
    if (typeof q !== 'number') continue;
    if (q > p) better += 1;
    else if (q === p) equal += 1; // includes `key` itself
  }
  return better + (equal + 1) / 2;
}

/** P(a random positive scores above a random negative); ties count half. Null if either side is empty. */
function auc(pos, neg) {
  if (!pos.length || !neg.length) return null;
  let wins = 0;
  for (const a of pos) {
    for (const b of neg) {
      if (a > b) wins += 1;
      else if (a === b) wins += 0.5;
    }
  }
  return Number((wins / (pos.length * neg.length)).toFixed(3));
}

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const round = (v, d = 3) => (v == null ? null : Number(v.toFixed(d)));

// The highest-ranked slot among `keys`, using the given score map (ties: earlier slot).
function topOf(scores) {
  let best = null;
  for (const k of SLOT_KEYS) {
    const v = scores[k];
    if (typeof v === 'number' && (best === null || v > scores[best])) best = k;
  }
  return best;
}

/**
 * @param {Array<{accepted: string[], probs: object}>} items
 * @returns the rank metrics described in the header; `n` counts scored items.
 */
function rankMetrics(items) {
  const rows = items.filter((it) => it && it.probs && Array.isArray(it.accepted) && it.accepted.length && SLOT_KEYS.some((k) => typeof it.probs[k] === 'number'));
  const n = rows.length;
  if (!n) return { n: 0, meanBestAcceptedRank: null, chanceMeanBestRank: null, topK: {}, aucBySlot: {}, macroAuc: null, biasCorrectedTop1: null };

  const bestRanks = [];
  const chanceRanks = [];
  const hits = { 1: 0, 2: 0, 3: 0 };
  const chance = { 1: [], 2: [], 3: [] };
  for (const it of rows) {
    const ranks = it.accepted.map((k) => rankOf(it.probs, k)).filter((r) => r != null);
    if (!ranks.length) continue;
    const best = Math.min(...ranks);
    bestRanks.push(best);
    chanceRanks.push(chanceBestRank(it.accepted.length));
    for (const k of [1, 2, 3]) {
      if (best <= k) hits[k] += 1;
      chance[k].push(chanceTopK(it.accepted.length, k));
    }
  }
  const scored = bestRanks.length;

  const topK = {};
  for (const k of [1, 2, 3]) topK[k] = { hit: hits[k], rate: scored ? round(hits[k] / scored) : null, chance: round(mean(chance[k])) };

  // per-slot AUC, and per-slot mean/std for the bias-corrected pick
  const aucBySlot = {};
  const aucs = [];
  const stats = {};
  for (const slot of SLOT_KEYS) {
    const pos = [];
    const neg = [];
    for (const it of rows) {
      const p = it.probs[slot];
      if (typeof p !== 'number') continue;
      (it.accepted.includes(slot) ? pos : neg).push(p);
    }
    const a = auc(pos, neg);
    aucBySlot[slot] = { auc: a, positives: pos.length, negatives: neg.length };
    if (a != null) aucs.push(a);
    const all = [...pos, ...neg];
    const mu = mean(all);
    const sd = all.length ? Math.sqrt(mean(all.map((v) => (v - mu) ** 2))) : 0;
    stats[slot] = { mu, sd };
  }

  let corrected = 0;
  let correctedN = 0;
  for (const it of rows) {
    const z = {};
    for (const slot of SLOT_KEYS) {
      const p = it.probs[slot];
      if (typeof p === 'number') z[slot] = stats[slot].sd > 0 ? (p - stats[slot].mu) / stats[slot].sd : 0;
    }
    const top = topOf(z);
    if (top) {
      correctedN += 1;
      if (it.accepted.includes(top)) corrected += 1;
    }
  }

  return {
    n: scored,
    meanBestAcceptedRank: round(mean(bestRanks), 2),
    chanceMeanBestRank: round(mean(chanceRanks), 2),
    topK,
    aucBySlot,
    macroAuc: aucs.length ? round(mean(aucs)) : null,
    biasCorrectedTop1: { hit: corrected, n: correctedN, rate: correctedN ? round(corrected / correctedN) : null, chance: topK[1].chance },
  };
}

module.exports = { rankOf, auc, chanceTopK, chanceBestRank, rankMetrics };
