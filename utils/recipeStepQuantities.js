/**
 * Keeps the quantities quoted in a recipe's cooking-step prose in line with
 * the ingredient list of the version those steps belong to.
 *
 * createCustomVersion (and so auto-balance / plan generation) copies `steps`
 * from the source version, so a re-portioned version used to keep the base
 * recipe's numbers in its text ("Cut the 100 g of Low-Fat Paneer" next to an
 * ingredient of 48.16 g). This rewrites "<qty> <unit> [(<qty> <unit>)] [of]
 * <ingredient name>" so <qty> is that ingredient's quantity.
 *
 * Deterministic, offline, idempotent. Left untouched on purpose:
 *   - a mention whose unit differs from the ingredient's unit (no guessing
 *     tsp <-> ml here),
 *   - an ingredient quoted in more than one step (split use, e.g. water in two
 *     steps) - the per-step share is unknowable.
 * Both are reported through `onSkip` for manual review.
 */

const UNIT_ALIASES = {
  g: 'g', gm: 'g', gram: 'g', grams: 'g',
  ml: 'ml',
  tsp: 'tsp', teaspoon: 'tsp', teaspoons: 'tsp',
  tbsp: 'tbsp', tablespoon: 'tbsp', tablespoons: 'tbsp',
  cup: 'cup', cups: 'cup',
  piece: 'piece', pieces: 'piece', nos: 'nos', bowl: 'bowl', bowls: 'bowl',
  egg: 'egg', eggs: 'egg', slice: 'slice', slices: 'slice',
};
const UNIT_RE = Object.keys(UNIT_ALIASES).sort((a, b) => b.length - a.length).join('|');

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const fmt = (n) => String(Math.round(n * 100) / 100);
const close = (a, b) => Math.abs(a - b) <= Math.max(0.01, Math.abs(b) * 0.005);

function mentionRegex(name) {
  // 1 qty, 2 spacing, 3 unit, 4 optional "(<qty> <unit>)", 5 the rest up to and including the name
  return new RegExp(
    String.raw`(\d+(?:\.\d+)?)(\s*)(${UNIT_RE})\b(\s*\(\s*\d+(?:\.\d+)?\s*(?:${UNIT_RE})\s*\))?(\s*(?:\([^)]*\)\s*)?(?:of\s+)?(?:the\s+)?${escapeRegExp(name)}\b)`,
    'gi'
  );
}

/**
 * @param {string[]} steps
 * @param {Array<{name:string, quantity:number, unit:string}>} ingredients
 * @param {{onSkip?: (info:{stepIndex:number, text:string, reason:string, ingredient:object}) => void}} [options]
 * @returns {{steps: string[], changes: Array<{stepIndex:number, before:string, after:string}>}}
 */
function rewriteStepQuantities(steps, ingredients, { onSkip } = {}) {
  const list = (ingredients || [])
    .filter((i) => i && i.name && i.quantity > 0)
    .sort((a, b) => b.name.length - a.name.length);
  const inputSteps = Array.isArray(steps) ? steps : [];

  // Pass 1: which ingredients are quoted with a quantity in more than one step.
  const mentionCounts = new Map();
  inputSteps.forEach((step) => {
    if (typeof step !== 'string') return;
    for (const ing of list) {
      const n = (step.match(mentionRegex(ing.name)) || []).length;
      if (n) mentionCounts.set(ing.name, (mentionCounts.get(ing.name) || 0) + n);
    }
  });
  const splitUse = new Set([...mentionCounts].filter(([, n]) => n > 1).map(([name]) => name));

  const changes = [];
  const out = inputSteps.map((step, stepIndex) => {
    if (typeof step !== 'string') return step;
    let text = step;
    for (const ing of list) {
      text = text.replace(mentionRegex(ing.name), (m, qty, sp, unitWord, paren, tail) => {
        if (splitUse.has(ing.name)) {
          onSkip?.({ stepIndex, text: m, reason: 'ingredient quoted in several steps', ingredient: ing });
          return m;
        }
        if (UNIT_ALIASES[unitWord.toLowerCase()] !== ing.unit) {
          onSkip?.({ stepIndex, text: m, reason: 'unit differs from ingredient unit', ingredient: ing });
          return m;
        }
        const oldQty = parseFloat(qty);
        if (close(oldQty, ing.quantity)) return m;
        // "2 g (1 tsp)": the bracketed equivalent changes by the same ratio.
        const ratio = ing.quantity / oldQty;
        const newParen = paren
          ? paren.replace(/(\d+(?:\.\d+)?)/, (n) => fmt(parseFloat(n) * ratio))
          : '';
        const replaced = `${fmt(ing.quantity)}${sp}${unitWord}${newParen}${tail}`;
        changes.push({ stepIndex, before: m, after: replaced });
        return replaced;
      });
    }
    return text;
  });

  return { steps: out, changes };
}

module.exports = { rewriteStepQuantities };
