const { parseCsvObjects } = require('../utils/layaCsv');
const { flip, topKey, buildReview, sheetCsv, keyCsv, wilson, scoreReview, SHEET_COLUMNS } = require('../utils/layaCategoryReview');

const classes = [
  { name: 'Indian', key: 'indian' },
  { name: 'Detox', key: 'detox' },
  { name: 'Smoothies & Drinks', key: 'smoothies_drinks' },
];
const item = (id, name, category, probs) => ({ id, name, category, ingredients: [{ name: 'oats' }, { name: 'milk' }], probs });

describe('topKey / flip', () => {
  it('picks the highest probability and ignores missing ones', () => {
    expect(topKey({ indian: 0.2, detox: 0.5, smoothies_drinks: 0.3 }, classes)).toBe('detox');
    expect(topKey(null, classes)).toBeNull();
    expect(topKey({ indian: null }, classes)).toBeNull();
  });

  it('is deterministic per recipe and seed, and varies across recipes', () => {
    expect(flip('abc', 1)).toBe(flip('abc', 1));
    const ids = Array.from({ length: 40 }, (_, i) => `recipe${i}`);
    const trues = ids.filter((id) => flip(id, 1)).length;
    expect(trues).toBeGreaterThan(8);
    expect(trues).toBeLessThan(32);
  });
});

describe('buildReview', () => {
  const items = [
    item('1', 'Banana shake', 'Indian', { indian: 0.1, detox: 0.1, smoothies_drinks: 0.8 }), // disagrees
    item('2', 'Paneer curry', 'Indian', { indian: 0.9, detox: 0.05, smoothies_drinks: 0.05 }), // agrees
    item('3', 'Green juice', 'Detox', { indian: 0.1, detox: 0.2, smoothies_drinks: 0.7 }), // disagrees
    item('4', 'Broken', 'Detox', null), // failed call
  ];

  it('keeps only the disagreements, counts the rest', () => {
    const r = buildReview({ items, classes, seed: 1 });
    expect(r.sheet.map((s) => s.id)).toEqual(['1', '3']);
    expect(r.agreed).toBe(1);
    expect(r.failed).toBe(1);
  });

  it('shows both options but never says which is the stored one or which is Laya (blind)', () => {
    const r = buildReview({ items, classes, seed: 1 });
    for (const row of r.sheet) {
      expect(Object.keys(row)).toEqual(SHEET_COLUMNS);
      expect(new Set([row.option_a, row.option_b]).size).toBe(2);
      expect(row.better_option).toBe('');
    }
    const csv = sheetCsv(r.sheet);
    expect(csv).not.toMatch(/stored|laya|probab/i);
    expect(csv.split('\r\n')[0]).toBe(SHEET_COLUMNS.join(','));
  });

  it('records in the key which option was which, and Laya\'s probability', () => {
    const r = buildReview({ items, classes, seed: 1 });
    for (const k of r.key) {
      const row = r.sheet.find((s) => s.id === k.id);
      const a = k.option_a_is === 'stored' ? k.stored_category : k.laya_category;
      expect(row.option_a).toBe(a);
    }
    expect(r.key.find((k) => k.id === '1')).toMatchObject({ stored_category: 'Indian', laya_category: 'Smoothies & Drinks', laya_probability: 0.8 });
    expect(keyCsv(r.key)).toMatch(/option_a_is/);
  });
});

describe('wilson', () => {
  it('is null for no data and brackets the rate', () => {
    expect(wilson(0, 0)).toBeNull();
    const [lo, hi] = wilson(6, 10);
    expect(lo).toBeLessThan(0.6);
    expect(hi).toBeGreaterThan(0.6);
  });
});

describe('scoreReview (round trip)', () => {
  const items = [
    item('1', 'Banana shake', 'Indian', { indian: 0.1, detox: 0.1, smoothies_drinks: 0.8 }),
    item('3', 'Green juice', 'Detox', { indian: 0.1, detox: 0.2, smoothies_drinks: 0.7 }),
    item('5', 'Lemon water', 'Detox', { indian: 0.1, detox: 0.2, smoothies_drinks: 0.7 }),
    item('6', 'Mystery', 'Indian', { indian: 0.1, detox: 0.2, smoothies_drinks: 0.7 }),
  ];
  const { sheet, key } = buildReview({ items, classes, seed: 3 });
  const keyText = keyCsv(key);
  const optionFor = (id, which) => {
    const k = key.find((x) => x.id === id);
    const storedIsA = k.option_a_is === 'stored';
    return which === 'stored' ? (storedIsA ? 'A' : 'B') : storedIsA ? 'B' : 'A';
  };
  const fill = (answers) => sheetCsv(sheet.map((row) => ({ ...row, ...(answers[row.id] || {}) })));

  it('translates A/B back to stored vs Laya through the key', () => {
    const text = fill({
      1: { better_option: optionFor('1', 'laya'), reviewed_by: 'Dr A' },
      3: { better_option: optionFor('3', 'stored'), reviewed_by: 'Dr A' },
      5: { better_option: 'both', reviewed_by: 'Dr A' },
      6: { better_option: 'neither', correct_category: 'Detox', reviewed_by: 'Dr A' },
    });
    const r = scoreReview(text, keyText);
    expect(r).toMatchObject({ reviewed: 4, pending: 0, laya: 1, stored: 1, both: 1, neither: 1, unsure: 0 });
    expect(r.layaShareOfDecided).toBe(0.5);
    expect(r.layaAcceptable).toBe(2);
    expect(r.corrections).toEqual([{ id: '6', correct: 'Detox' }]);
    expect(r.byStored.Detox).toMatchObject({ stored: 1, both: 1 });
    expect(r.problems).toEqual([]);
  });

  it('leaves untouched rows pending and reports bad rows instead of dropping them', () => {
    const text = fill({
      1: { better_option: 'x', reviewed_by: 'Dr A' }, // invalid value
      3: { better_option: 'a' }, // no reviewer
    });
    const r = scoreReview(text, keyText);
    expect(r.reviewed).toBe(0);
    expect(r.pending).toBe(2);
    expect(r.problems).toHaveLength(2);
    expect(r.problems.join(' ')).toMatch(/not one of/);
    expect(r.problems.join(' ')).toMatch(/no reviewed_by/);
  });

  it('survives a spreadsheet round trip (quoted commas in ingredients)', () => {
    const rows = parseCsvObjects(fill({}));
    expect(rows[0].ingredients).toBe('oats, milk');
  });
});
