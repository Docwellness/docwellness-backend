/**
 * Trivial, non-LLM baselines for "which serving slot does this recipe suit?",
 * trained on the recipes' EXISTING slot labels and scored leave-one-out (each
 * recipe is scored by a model that has never seen it). They exist to answer one
 * question honestly: does Laya tell us anything the data did not already say?
 *
 *  - global:    how common each slot is overall (the base rate; no recipe info)
 *  - category:  how common each slot is within the recipe's category
 *  - naiveBayes: bag-of-words (name, category, cuisine, ingredient names)
 *
 * Each returns a score per slot key, higher = better fit, so the same rank
 * metrics (utils/layaRank.js) apply to them and to Laya. Laya never saw these
 * labels, so beating them is a high bar; clearly losing to them means the extra
 * cost (and ~11 s a call) needs a different justification.
 *
 * Pure, no I/O. A recipe is { id, name, cuisine, category, slot, ingredients: [{name}] }.
 */

const { SLOT_KEYS } = require('./layaSlots');

const K = SLOT_KEYS.length;
const STOP = new Set(['and', 'with', 'the', 'for', 'of', 'in', 'a', 'an', 'to', 'or', 'on', 'from', 'style']);

/** The unique feature tokens of a recipe (lower-case words, plus the category as one token). */
function features(recipe) {
  const text = [recipe.name, recipe.cuisine, ...(recipe.ingredients || []).map((i) => (typeof i === 'string' ? i : i.name))].join(' ');
  const tokens = new Set((text.toLowerCase().match(/[a-z]+/g) || []).filter((t) => t.length > 1 && !STOP.has(t)));
  tokens.add(`cat:${(recipe.category || 'none').toLowerCase()}`);
  return tokens;
}

/** Counts needed by all three baselines, from a list of recipes with known slots. */
function fit(recipes) {
  const m = { n: 0, slot: {}, cat: {}, catN: {}, tok: {}, tokN: {}, vocab: new Set() };
  for (const k of SLOT_KEYS) {
    m.slot[k] = 0;
    m.tok[k] = {};
    m.tokN[k] = 0;
  }
  for (const r of recipes) {
    if (!SLOT_KEYS.includes(r.slot)) continue;
    m.n += 1;
    m.slot[r.slot] += 1;
    const cat = (r.category || 'none').toLowerCase();
    m.cat[cat] = m.cat[cat] || Object.fromEntries(SLOT_KEYS.map((k) => [k, 0]));
    m.cat[cat][r.slot] += 1;
    m.catN[cat] = (m.catN[cat] || 0) + 1;
    for (const t of features(r)) {
      m.tok[r.slot][t] = (m.tok[r.slot][t] || 0) + 1;
      m.tokN[r.slot] += 1;
      m.vocab.add(t);
    }
  }
  return m;
}

const normalise = (scores) => {
  const total = SLOT_KEYS.reduce((s, k) => s + scores[k], 0);
  return Object.fromEntries(SLOT_KEYS.map((k) => [k, total > 0 ? scores[k] / total : 1 / K]));
};

/** Slot frequencies over everything EXCEPT `recipe` (leave-one-out). */
function globalPrior(m, recipe) {
  const n = m.n - 1;
  return normalise(Object.fromEntries(SLOT_KEYS.map((k) => [k, (m.slot[k] - (recipe.slot === k ? 1 : 0) + 1) / (n + K)])));
}

/** Slot frequencies within the recipe's category, excluding the recipe, smoothed toward the global prior. */
function categoryPrior(m, recipe, alpha = 1) {
  const cat = (recipe.category || 'none').toLowerCase();
  const base = globalPrior(m, recipe);
  const counts = m.cat[cat] || Object.fromEntries(SLOT_KEYS.map((k) => [k, 0]));
  const total = (m.catN[cat] || 0) - 1;
  return normalise(Object.fromEntries(SLOT_KEYS.map((k) => [k, (counts[k] - (recipe.slot === k ? 1 : 0) + alpha * base[k]) / (Math.max(total, 0) + alpha)])));
}

/** Multinomial (binary-feature) naive Bayes with Laplace smoothing, excluding the recipe. */
function naiveBayes(m, recipe) {
  const toks = features(recipe);
  const V = m.vocab.size;
  const n = m.n - 1;
  const logp = {};
  for (const k of SLOT_KEYS) {
    const own = recipe.slot === k;
    let lp = Math.log((m.slot[k] - (own ? 1 : 0) + 1) / (n + K));
    const denom = m.tokN[k] - (own ? toks.size : 0) + V;
    for (const t of toks) {
      const c = (m.tok[k][t] || 0) - (own ? 1 : 0);
      lp += Math.log((Math.max(c, 0) + 1) / denom);
    }
    logp[k] = lp;
  }
  const max = Math.max(...Object.values(logp));
  return normalise(Object.fromEntries(SLOT_KEYS.map((k) => [k, Math.exp(logp[k] - max)])));
}

/** { recipeId: { global, category, naiveBayes } } - every score from a model that excluded that recipe. */
function leaveOneOut(recipes) {
  const usable = recipes.filter((r) => SLOT_KEYS.includes(r.slot));
  const m = fit(usable);
  const out = {};
  for (const r of usable) {
    out[r.id] = { global: globalPrior(m, r), category: categoryPrior(m, r), naiveBayes: naiveBayes(m, r) };
  }
  return out;
}

module.exports = { features, fit, globalPrior, categoryPrior, naiveBayes, leaveOneOut };
