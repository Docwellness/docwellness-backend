const {
  QUESTION_ID, categoryKey, selectClasses, buildCategoryRequest, categoryProbabilities, rankOfTrue, categoryMetrics, leaveOneOutBaseline,
} = require('../utils/layaCategory');

const rec = (id, name, category, ings = []) => ({ id, name, category, cuisine: 'Indian', ingredients: ings.map((n) => ({ name: n })) });

describe('categoryKey / selectClasses', () => {
  it('makes stable option keys', () => {
    expect(categoryKey('Smoothies & Drinks')).toBe('smoothies_drinks');
    expect(categoryKey('High Protein')).toBe('high_protein');
  });

  it('keeps categories with enough recipes, drops catch-alls, sorts by size', () => {
    const rs = [
      ...Array.from({ length: 6 }, (_, i) => rec(`a${i}`, 'x', 'Indian')),
      ...Array.from({ length: 5 }, (_, i) => rec(`b${i}`, 'x', 'Detox')),
      ...Array.from({ length: 9 }, (_, i) => rec(`c${i}`, 'x', 'Other')),
      rec('d', 'x', 'Thai'),
    ];
    expect(selectClasses(rs).map((c) => c.name)).toEqual(['Indian', 'Detox']);
    expect(selectClasses(rs, { minPerClass: 1 }).map((c) => c.name)).toEqual(['Indian', 'Detox', 'Thai']);
  });
});

describe('buildCategoryRequest', () => {
  const classes = [{ name: 'Indian', key: 'indian' }, { name: 'Detox', key: 'detox' }];
  const r = rec('1', 'Moong Dal Khichdi', 'Indian', ['rice', 'moong dal']);

  it('never sends category or cuisine (they are the answer / a copy of it)', () => {
    for (const withIngredients of [false, true]) {
      const req = buildCategoryRequest(r, classes, { withIngredients });
      expect(Object.keys(req.state)).not.toContain('category');
      expect(Object.keys(req.state)).not.toContain('cuisine');
      expect(JSON.stringify(req.state)).not.toMatch(/Indian/);
    }
  });

  it('is name only by default, adds ingredient names on request, one choice question over the classes', () => {
    expect(buildCategoryRequest(r, classes).state).toEqual({ name: 'Moong Dal Khichdi' });
    expect(buildCategoryRequest(r, classes, { withIngredients: true }).state.ingredients).toEqual(['rice', 'moong dal']);
    const q = buildCategoryRequest(r, classes).questions[QUESTION_ID];
    expect(q.type).toBe('choice');
    expect(q.criteria).toEqual({ indian: 'Indian', detox: 'Detox' });
  });
});

describe('metrics', () => {
  const classes = [{ name: 'A', key: 'a' }, { name: 'B', key: 'b' }, { name: 'C', key: 'c' }];

  it('shares a tied rank so a flat answer is not rewarded', () => {
    expect(rankOfTrue({ a: 0.5, b: 0.5, c: 0 }, 'a')).toBe(1.5);
    expect(rankOfTrue({ a: 0.2, b: 0.5, c: 0.3 }, 'a')).toBe(3);
    expect(rankOfTrue({ a: null, b: 1 }, 'a')).toBeNull();
  });

  it('is perfect for a perfect classifier and at chance for a flat one', () => {
    const items = ['a', 'a', 'b', 'b', 'c', 'c'];
    const perfect = categoryMetrics(items.map((k) => ({ trueKey: k, probs: { a: k === 'a' ? 1 : 0, b: k === 'b' ? 1 : 0, c: k === 'c' ? 1 : 0 } })), classes);
    expect(perfect).toMatchObject({ n: 6, top1: 1, top2: 1, meanRank: 1, macroAuc: 1, chanceTop1: 0.333 });
    const flat = categoryMetrics(items.map((k) => ({ trueKey: k, probs: { a: 1 / 3, b: 1 / 3, c: 1 / 3 } })), classes);
    expect(flat.macroAuc).toBe(0.5);
    expect(flat.meanRank).toBe(2);
  });

  it('skips failed calls and reads Laya answers', () => {
    expect(categoryMetrics([{ trueKey: 'a', probs: null }], classes).n).toBe(0);
    const answers = { [QUESTION_ID]: { probabilities: { a: 0.7, b: 0.2, c: 0.1 } } };
    expect(categoryProbabilities(answers, classes)).toEqual({ a: 0.7, b: 0.2, c: 0.1 });
    expect(categoryProbabilities({}, classes)).toEqual({ a: null, b: null, c: null });
  });
});

describe('leaveOneOutBaseline', () => {
  const classes = [{ name: 'Smoothies', key: 'smoothies' }, { name: 'Indian', key: 'indian' }];
  const recipes = [
    rec('1', 'Banana smoothie', 'Smoothies'), rec('2', 'Mango smoothie', 'Smoothies'), rec('3', 'Berry smoothie', 'Smoothies'),
    rec('4', 'Paneer curry', 'Indian'), rec('5', 'Dal curry', 'Indian'), rec('6', 'Aloo curry', 'Indian'),
  ];

  it('predicts from words in the OTHER recipes, probabilities sum to 1', () => {
    const loo = leaveOneOutBaseline(recipes, classes);
    expect(loo.get('1').smoothies).toBeGreaterThan(0.5);
    expect(loo.get('4').indian).toBeGreaterThan(0.5);
    for (const p of loo.values()) expect(p.smoothies + p.indian).toBeCloseTo(1, 6);
  });

  it('never uses a recipe to predict itself (a word seen only in it gives no evidence)', () => {
    const rs = [...recipes, rec('7', 'Zucchini smoothie', 'Smoothies'), rec('8', 'Zucchini curry', 'Indian')];
    const loo = leaveOneOutBaseline(rs, classes);
    // "zucchini" is in both classes once; with leave-one-out each recipe's own copy is removed, so only smoothie/curry decide
    expect(loo.get('7').smoothies).toBeGreaterThan(0.5);
    expect(loo.get('8').indian).toBeGreaterThan(0.5);
  });
});
