/**
 * Recipe `category` classification experiment: can Laya recover the category a
 * dietician chose, from the recipe's name (and ingredients) alone?
 *
 * Why this is a fair question only if two fields are hidden: `category` is
 * largely a copy of `cuisine` (every Indian / North Indian / South Indian
 * recipe is category "Indian"), and the category itself is the answer. So the
 * request built here carries NEITHER (same lesson as servingTime, 2026-10-05).
 *
 * Pure helpers, no I/O: the request, Laya's answer -> probabilities, the
 * metrics, and a trained baseline (multinomial naive Bayes, uniform prior,
 * leave-one-out) that Laya has to beat to earn a place. Agreement with the
 * existing label is NOT accuracy: the label is a mix of cuisine, diet and
 * product type, so some of it is judgement a name cannot show.
 */
const { auc } = require('./layaRank');

const QUESTION_ID = 'category_fit';

/** 'Smoothies & Drinks' -> 'smoothies_drinks' (stable, valid as an option key). */
function categoryKey(name) {
  return String(name).toLowerCase().replace(/&/g, ' ').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

/**
 * Categories worth testing: at least `minPerClass` recipes, minus catch-alls.
 * Returns [{ name, key, count }] sorted by count desc then name.
 */
function selectClasses(recipes, { minPerClass = 5, exclude = ['Other'] } = {}) {
  const counts = new Map();
  for (const r of recipes) if (r.category) counts.set(r.category, (counts.get(r.category) || 0) + 1);
  return [...counts.entries()]
    .filter(([name, n]) => n >= minPerClass && !exclude.includes(name))
    .map(([name, count]) => ({ name, key: categoryKey(name), count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/** { state, questions } for one recipe. Never includes category or cuisine. */
function buildCategoryRequest(recipe, classes, { withIngredients = false } = {}) {
  const state = { name: recipe.name };
  if (withIngredients) state.ingredients = (recipe.ingredients || []).map((i) => i.name);
  return {
    state,
    questions: {
      [QUESTION_ID]: {
        type: 'choice',
        instructions: 'Which category does this recipe belong to?',
        criteria: Object.fromEntries(classes.map((c) => [c.key, c.name])),
      },
    },
  };
}

/** Laya's answers -> { classKey: probability | null }. */
function categoryProbabilities(answers, classes) {
  const p = answers && answers[QUESTION_ID] && answers[QUESTION_ID].probabilities;
  const out = {};
  for (const c of classes) out[c.key] = p && typeof p[c.key] === 'number' ? p[c.key] : null;
  return out;
}

/** 1 = best. Ties share the average position, so a flat answer does not look lucky. */
function rankOfTrue(probs, trueKey) {
  const mine = probs[trueKey];
  if (typeof mine !== 'number') return null;
  let better = 0;
  let equal = 0;
  for (const [k, v] of Object.entries(probs)) {
    if (typeof v !== 'number') continue;
    if (v > mine) better += 1;
    else if (v === mine && k !== trueKey) equal += 1;
  }
  // the true class and `equal` others share positions better+1 .. better+1+equal
  return better + 1 + equal / 2;
}

/**
 * @param {Array<{trueKey, probs}>} items  probs null/absent for failed calls (skipped)
 * @param {Array<{key}>} classes
 * Chance for K balanced classes: top-1 1/K, top-2 2/K, mean rank (K+1)/2, AUC 0.5.
 */
function categoryMetrics(items, classes) {
  const scored = items.filter((i) => i.probs && rankOfTrue(i.probs, i.trueKey) != null);
  const K = classes.length;
  if (!scored.length) return { n: 0, K, chanceTop1: 1 / K, chanceTop2: Math.min(1, 2 / K), chanceMeanRank: (K + 1) / 2 };
  const ranks = scored.map((i) => rankOfTrue(i.probs, i.trueKey));
  const share = (pred) => ranks.filter(pred).length / ranks.length;
  const aucs = [];
  const perClass = {};
  for (const c of classes) {
    const pos = scored.filter((i) => i.trueKey === c.key).map((i) => i.probs[c.key]);
    const neg = scored.filter((i) => i.trueKey !== c.key).map((i) => i.probs[c.key]);
    const a = auc(pos, neg);
    const mine = scored.filter((i) => i.trueKey === c.key);
    perClass[c.name] = {
      n: mine.length,
      top1: mine.length ? mine.filter((i) => rankOfTrue(i.probs, i.trueKey) <= 1).length / mine.length : null,
      auc: a,
    };
    if (a != null) aucs.push(a);
  }
  const round = (v) => Number(v.toFixed(3));
  return {
    n: scored.length,
    K,
    meanRank: round(ranks.reduce((a, b) => a + b, 0) / ranks.length),
    top1: round(share((r) => r <= 1)),
    top2: round(share((r) => r <= 2)),
    macroAuc: aucs.length ? round(aucs.reduce((a, b) => a + b, 0) / aucs.length) : null,
    perClass,
    chanceTop1: round(1 / K),
    chanceTop2: round(Math.min(1, 2 / K)),
    chanceMeanRank: (K + 1) / 2,
  };
}

// ---- baseline: multinomial naive Bayes on the same words Laya sees ----------
const tokens = (text) => String(text || '').toLowerCase().split(/[^a-z]+/).filter((t) => t.length >= 3);

function wordsOf(recipe, withIngredients) {
  const w = tokens(recipe.name);
  if (withIngredients) for (const i of recipe.ingredients || []) w.push(...tokens(i.name));
  return w;
}

/**
 * Leave-one-out probabilities for every recipe in `recipes` (all must have a
 * category among `classes`): trained on all the others, uniform class prior
 * (the evaluation sample is balanced), add-one smoothing.
 * @returns {Map<id, {classKey: probability}>}
 */
function leaveOneOutBaseline(recipes, classes, { withIngredients = false } = {}) {
  const keyOf = new Map(classes.map((c) => [c.name, c.key]));
  const docs = recipes.filter((r) => keyOf.has(r.category)).map((r) => ({ id: r.id, key: keyOf.get(r.category), words: wordsOf(r, withIngredients) }));
  const vocab = new Set();
  const wordCount = Object.fromEntries(classes.map((c) => [c.key, new Map()]));
  const total = Object.fromEntries(classes.map((c) => [c.key, 0]));
  for (const d of docs) {
    for (const w of d.words) {
      vocab.add(w);
      wordCount[d.key].set(w, (wordCount[d.key].get(w) || 0) + 1);
      total[d.key] += 1;
    }
  }
  const out = new Map();
  for (const d of docs) {
    const own = new Map();
    for (const w of d.words) own.set(w, (own.get(w) || 0) + 1);
    const logp = {};
    for (const c of classes) {
      let lp = 0;
      const sameClass = c.key === d.key;
      const denom = total[c.key] - (sameClass ? d.words.length : 0) + vocab.size;
      for (const w of d.words) {
        const cnt = (wordCount[c.key].get(w) || 0) - (sameClass ? own.get(w) || 0 : 0);
        lp += Math.log((cnt + 1) / denom);
      }
      logp[c.key] = lp;
    }
    const max = Math.max(...Object.values(logp));
    const exp = Object.fromEntries(Object.entries(logp).map(([k, v]) => [k, Math.exp(v - max)]));
    const sum = Object.values(exp).reduce((a, b) => a + b, 0);
    out.set(d.id, Object.fromEntries(Object.entries(exp).map(([k, v]) => [k, v / sum])));
  }
  return out;
}

/** One Laya call with a short wait-and-retry while Laya is busy (HTTP 503). */
async function askWithRetry(askLaya, request, { retries = 3, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), retryDelayMs = 3000 } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop
    const r = await askLaya(request);
    if (!r.ok && /HTTP 503/.test(r.detail || '') && attempt < retries) {
      // eslint-disable-next-line no-await-in-loop
      await sleep(retryDelayMs);
      continue;
    }
    return r;
  }
}

module.exports = {
  askWithRetry,
  QUESTION_ID,
  categoryKey,
  selectClasses,
  buildCategoryRequest,
  categoryProbabilities,
  rankOfTrue,
  categoryMetrics,
  leaveOneOutBaseline,
};
