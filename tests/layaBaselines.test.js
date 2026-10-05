/**
 * Baselines (utils/layaBaselines.js) and the protein check (utils/layaProtein.js).
 * Synthetic fixtures that check the arithmetic and, above all, the leave-one-out
 * discipline: a recipe must never be scored by a model that saw it.
 */

const { SLOT_KEYS } = require('../utils/layaSlots');
const { rankMetrics } = require('../utils/layaRank');
const { features, fit, globalPrior, categoryPrior, naiveBayes, leaveOneOut } = require('../utils/layaBaselines');
const { ranks, spearman, proteinScore, proteinSummary } = require('../utils/layaProtein');

let n = 0;
const recipe = (name, slot, category = 'Indian', ingredients = []) => ({
  id: `r${(n += 1)}`, name, slot, category, cuisine: null, ingredients: ingredients.map((i) => ({ name: i })),
});
const sum = (probs) => SLOT_KEYS.reduce((s, k) => s + probs[k], 0);

describe('features', () => {
  it('uses unique lower-case words from name, cuisine and ingredients, drops stop words, adds the category', () => {
    const f = features({ name: 'Masala Tea with Ginger', cuisine: 'Indian', category: 'Smoothies & Drinks', ingredients: [{ name: 'Black Tea' }, 'Ginger'] });
    expect([...f].sort()).toEqual(['black', 'cat:smoothies & drinks', 'ginger', 'indian', 'masala', 'tea'].sort());
  });
  it('gives a missing category its own token', () => {
    expect(features({ name: 'X', ingredients: [] }).has('cat:none')).toBe(true);
  });
});

describe('priors', () => {
  const corpus = [
    ...Array.from({ length: 6 }, (_, i) => recipe(`Dal ${i}`, 'lunch', 'Indian')),
    ...Array.from({ length: 2 }, (_, i) => recipe(`Tea ${i}`, 'morning_drink', 'Drinks')),
    recipe('Lone', 'dinner', 'Unique'),
  ];
  const m = fit(corpus);

  it('global prior is a distribution over all seven slots, favouring the common slot', () => {
    const g = globalPrior(m, corpus[0]);
    expect(sum(g)).toBeCloseTo(1, 10);
    expect(g.lunch).toBeGreaterThan(g.dinner);
  });

  it('excludes the recipe itself (leave-one-out): the only recipe of a category cannot vouch for itself', () => {
    const lone = corpus[corpus.length - 1];
    const cat = categoryPrior(m, lone);
    const glob = globalPrior(m, lone);
    // its category has no OTHER recipe, so the category prior collapses to the global prior
    for (const k of SLOT_KEYS) expect(cat[k]).toBeCloseTo(glob[k], 6);
    expect(cat.dinner).toBeLessThan(0.3); // would be ~1.0 if it had seen its own label
  });

  it('category prior leans on the category when other recipes share it', () => {
    const c = categoryPrior(m, corpus[6]); // a tea: the other tea says morning_drink
    expect(c.morning_drink).toBeGreaterThan(c.lunch);
  });
});

describe('naiveBayes', () => {
  const corpus = [
    ...Array.from({ length: 5 }, (_, i) => recipe(`Ginger Tea ${i}`, 'morning_drink', 'Drinks', ['Tea Leaves', 'Water'])),
    ...Array.from({ length: 5 }, (_, i) => recipe(`Dal Tadka ${i}`, 'dinner', 'Indian', ['Toor Dal', 'Ghee'])),
    ...Array.from({ length: 5 }, (_, i) => recipe(`Poha ${i}`, 'breakfast', 'Indian', ['Flattened Rice', 'Peanuts'])),
  ];
  const m = fit(corpus);

  it('learns which words go with which slot', () => {
    const p = naiveBayes(m, { id: 'new', name: 'Tulsi Tea', slot: null, category: 'Drinks', ingredients: [{ name: 'Tea Leaves' }] });
    expect(sum(p)).toBeCloseTo(1, 8);
    expect(SLOT_KEYS.reduce((best, k) => (p[k] > p[best] ? k : best), SLOT_KEYS[0])).toBe('morning_drink');
  });

  it('never lets a recipe see its own label: scoring it from a model that includes it must not help', () => {
    // A recipe with words nobody else has: if it could see itself it would be near-certain; held out it is not.
    const odd = recipe('Zzyzx Qwerty', 'night_drink', 'Odd', ['Quux']);
    const withOdd = fit([...corpus, odd]);
    const held = naiveBayes(withOdd, odd); // excludes `odd`
    expect(held.night_drink).toBeLessThan(0.5);
    // The exact property: scoring `odd` from a model that included it (and excluded it again) equals
    // scoring it from a model built WITHOUT it. The only thing the two models can differ in is the
    // vocabulary size, which shifts every slot's smoothing equally, so align it and demand equality.
    const without = fit(corpus);
    without.vocab = new Set([...without.vocab, ...features(odd)]);
    const fromWithout = naiveBayes(without, { ...odd, slot: null });
    for (const k of SLOT_KEYS) expect(held[k]).toBeCloseTo(fromWithout[k], 8);
  });

  it('leaveOneOut scores every recipe from a model that excluded it, and rank metrics can be computed', () => {
    const loo = leaveOneOut(corpus);
    expect(Object.keys(loo)).toHaveLength(15);
    const items = corpus.map((r) => ({ accepted: [r.slot], probs: loo[r.id].naiveBayes }));
    const m2 = rankMetrics(items);
    expect(m2.topK[1].rate).toBeGreaterThan(0.9); // the three groups are cleanly separable by words
    const base = rankMetrics(corpus.map((r) => ({ accepted: [r.slot], probs: loo[r.id].global })));
    expect(m2.macroAuc).toBeGreaterThan(base.macroAuc);
  });

  it('a no-information baseline (global prior) is near chance for balanced classes', () => {
    const loo = leaveOneOut(corpus);
    const g = rankMetrics(corpus.map((r) => ({ accepted: [r.slot], probs: loo[r.id].global })));
    expect(g.macroAuc).toBeLessThan(0.75);
  });
});

describe('protein check', () => {
  it('ranks with average ties and computes Spearman', () => {
    expect(ranks([10, 20, 20, 30])).toEqual([1, 2.5, 2.5, 4]);
    expect(spearman([1, 2, 3, 4], [10, 20, 30, 40])).toBe(1);
    expect(spearman([1, 2, 3, 4], [40, 30, 20, 10])).toBe(-1);
    expect(spearman([1, 1, 1, 1], [1, 2, 3, 4])).toBeNull(); // constant: undefined
    expect(spearman([1, 2], [1, 2])).toBeNull(); // too few
  });

  it('scores a protein answer as P(high) - P(low), null without probabilities', () => {
    expect(proteinScore({ probabilities: { low: 0.2, moderate: 0.3, high: 0.5 } })).toBe(0.3);
    expect(proteinScore({ choice: 'low' })).toBeNull();
    expect(proteinScore(null)).toBeNull();
  });

  const row = (grams, high, slot = 'lunch', choice) => ({
    sourceSlot: slot, proteinG: grams,
    protein: { choice: choice || (high > 0.5 ? 'high' : 'low'), probabilities: { low: 1 - high - 0.1, moderate: 0.1, high } },
  });

  it('finds a strong relationship when Laya orders recipes by grams', () => {
    const rows = [2, 4, 6, 8, 10, 12, 20, 25, 30].map((g, i) => row(g, 0.1 + i * 0.1));
    const s = proteinSummary(rows);
    expect(s.n).toBe(9);
    expect(s.spearman).toBe(1);
    expect(s.aucHighVsLowThird).toBe(1);
    expect(s.withinSlotSpearman.mean).toBe(1);
  });

  it('finds none when the order is unrelated, and a negative one when reversed', () => {
    const grams = [2, 4, 6, 8, 10, 12, 20, 25, 30];
    expect(proteinSummary(grams.map((g, i) => row(g, 0.9 - i * 0.1))).spearman).toBe(-1);
    const flat = proteinSummary(grams.map((g) => row(g, 0.5)));
    expect(flat.spearman).toBeNull(); // identical scores: no ordering at all
  });

  it('reports the tier agreement with the grams tertiles, and within-slot correlation separately', () => {
    const rows = [
      ...[2, 5, 9].map((g, i) => row(g, 0.1 + i * 0.05, 'morning_drink')),
      ...[10, 14, 20, 26, 30].map((g, i) => row(g, 0.3 + i * 0.1, 'dinner')),
      row(40, 0.9, 'dinner'),
    ];
    const s = proteinSummary(rows);
    expect(s.tierAgreement.chance).toBeCloseTo(0.333, 2);
    expect(s.tierAgreement.n).toBe(9);
    expect(Object.keys(s.withinSlotSpearman.bySlot)).toEqual(['dinner']); // drinks has only 3 rows: not enough
  });

  it('skips rows with no gram value or no Laya probabilities, and declines when too few remain', () => {
    const rows = [row(5, 0.2), { sourceSlot: 'lunch', proteinG: null, protein: { probabilities: { low: 0.5, moderate: 0.2, high: 0.3 } } }, { sourceSlot: 'lunch', proteinG: 9, protein: null }];
    const s = proteinSummary(rows);
    expect(s.n).toBe(1);
    expect(s.note).toMatch(/too few/);
  });
});
