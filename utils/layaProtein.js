/**
 * An objective check of Laya's protein_level answer that needs no human labels:
 * compare it with the exact protein per serving already in the nutrition data
 * (Recipe.nutritionPerServing.protein, grams).
 *
 * Laya's answer is a probability over low / moderate / high, so each recipe gets
 * one score, P(high) - P(low), and everything here is rank-based (no gram
 * threshold has to be chosen):
 *   - Spearman rank correlation between that score and the grams
 *   - AUC for telling the highest-protein third of recipes from the lowest third
 *   - Laya's chosen tier vs the grams tertile (exact agreement, vs ~33% chance)
 *   - the same correlation WITHIN each serving slot, averaged, because "high
 *     protein relative to a typical dish of its type" is not the same as raw grams
 *     (a 4 g tea can be high for a tea): comparing within a slot controls for
 *     most of that.
 *
 * It does not say Laya should replace the nutrition data (it must not: the plan
 * keeps nutrition exact). It says whether Laya's protein tier carries any
 * information; if the nutrition data already answers the question exactly, the
 * Laya tier is redundant either way. Pure, no I/O.
 */

const { auc } = require('./layaRank');

const TIERS = ['low', 'moderate', 'high'];

/** Average ranks (1-based, ties share the mean rank). */
function ranks(values) {
  const idx = values.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const out = new Array(values.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j += 1;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k += 1) out[idx[k][1]] = avg;
    i = j + 1;
  }
  return out;
}

/** Spearman rank correlation (Pearson on average ranks); null if undefined. */
function spearman(xs, ys) {
  if (xs.length !== ys.length || xs.length < 3) return null;
  const rx = ranks(xs);
  const ry = ranks(ys);
  const mx = rx.reduce((a, b) => a + b, 0) / rx.length;
  const my = ry.reduce((a, b) => a + b, 0) / ry.length;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < rx.length; i += 1) {
    num += (rx[i] - mx) * (ry[i] - my);
    dx += (rx[i] - mx) ** 2;
    dy += (ry[i] - my) ** 2;
  }
  if (dx === 0 || dy === 0) return null;
  return Number((num / Math.sqrt(dx * dy)).toFixed(3));
}

/** P(high) - P(low) from Laya's protein answer (choice form with probabilities), else null. */
function proteinScore(protein) {
  const p = protein && protein.probabilities;
  if (!p || typeof p.high !== 'number' || typeof p.low !== 'number') return null;
  return Number((p.high - p.low).toFixed(4));
}

const round = (v) => (v == null ? null : Number(v.toFixed(3)));

/**
 * @param {Array<{protein, proteinG, sourceSlot}>} results  from the smoke test
 * Rows without Laya's protein probabilities or without a gram value are skipped.
 */
function proteinSummary(results) {
  const rows = results
    .map((r) => ({ score: proteinScore(r.protein), grams: r.proteinG, choice: r.protein && r.protein.choice, slot: r.sourceSlot }))
    .filter((r) => r.score != null && typeof r.grams === 'number' && Number.isFinite(r.grams));
  const n = rows.length;
  if (n < 6) return { n, note: 'too few recipes with both a Laya protein answer and protein grams to say anything' };

  const rho = spearman(rows.map((r) => r.score), rows.map((r) => r.grams));

  // gram tertiles by rank: lowest third = low, highest third = high
  const gr = ranks(rows.map((r) => r.grams));
  const cut = (v) => (v <= n / 3 ? 'low' : v > (2 * n) / 3 ? 'high' : 'moderate');
  const tier = gr.map((rk) => cut(rk));
  const lowScores = rows.filter((_, i) => tier[i] === 'low').map((r) => r.score);
  const highScores = rows.filter((_, i) => tier[i] === 'high').map((r) => r.score);

  const confusion = {};
  let agree = 0;
  let counted = 0;
  rows.forEach((r, i) => {
    if (!TIERS.includes(r.choice)) return;
    counted += 1;
    if (r.choice === tier[i]) agree += 1;
    const key = `grams ${tier[i]} -> Laya ${r.choice}`;
    confusion[key] = (confusion[key] || 0) + 1;
  });

  const bySlot = {};
  const slots = [...new Set(rows.map((r) => r.slot).filter(Boolean))];
  for (const s of slots) {
    const g = rows.filter((r) => r.slot === s);
    if (g.length >= 5) bySlot[s] = { n: g.length, rho: spearman(g.map((r) => r.score), g.map((r) => r.grams)) };
  }
  const slotRhos = Object.values(bySlot).map((b) => b.rho).filter((v) => v != null);

  return {
    n,
    spearman: rho,
    aucHighVsLowThird: auc(highScores, lowScores),
    tierAgreement: { agree, n: counted, rate: counted ? round(agree / counted) : null, chance: round(1 / 3) },
    confusion,
    withinSlotSpearman: { bySlot, mean: slotRhos.length ? round(slotRhos.reduce((a, b) => a + b, 0) / slotRhos.length) : null, slots: slotRhos.length },
    note: 'Spearman 0 = no relationship, 1 = Laya orders recipes exactly by grams; AUC 0.5 = no signal. Rank-based: no gram threshold is assumed.',
  };
}

module.exports = { ranks, spearman, proteinScore, proteinSummary };
