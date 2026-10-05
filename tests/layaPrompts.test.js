/**
 * Prompt variants (utils/layaPrompts.js) and the ablation analysis
 * (utils/layaAblation.js). Synthetic fixtures; no Laya, no database.
 */

const realFetch = global.fetch;
const mockFetch = jest.fn();
global.fetch = mockFetch;
afterAll(() => {
  global.fetch = realFetch;
});

const config = require('../config/environment');
const { classifyRecipe, askLaya } = require('../services/layaDecisionService');
const { SLOT_KEYS } = require('../utils/layaSlots');
const { VARIANTS, VARIANT_IDS, variantById, buildRequest, buildProteinQuestion } = require('../utils/layaPrompts');
const { summarizeVariant, compareVariants } = require('../utils/layaAblation');

// Includes a servingTime on purpose: no variant may ever send it.
const recipe = {
  name: 'Palak Chilla',
  cuisine: 'North Indian',
  category: 'Indian',
  servingTime: 'Breakfast',
  ingredients: ['Besan', 'Spinach', 'Onion', 'Green Chilli', 'Turmeric', 'Salt', 'Oil'].map((name) => ({ name })),
};

beforeEach(() => {
  mockFetch.mockReset();
  config.laya.enabled = true;
  config.laya.baseUrl = 'http://laya.internal:8000';
  config.laya.apiKey = 'k';
  config.laya.model = 'laya-typed-decisions';
  config.laya.timeoutMs = 50;
  config.laya.slotMode = undefined;
});

describe('the variants', () => {
  it('are listed with unique ids, the production request first', () => {
    expect(VARIANT_IDS[0]).toBe('current');
    expect(new Set(VARIANT_IDS).size).toBe(VARIANT_IDS.length);
    expect(VARIANT_IDS).toEqual(['current', 'no_protein', 'labels_protein', 'short_desc', 'labels', 'labels_5ing', 'labels_min']);
    for (const v of VARIANTS) expect(v.label.length).toBeGreaterThan(10);
  });

  it('`current` is EXACTLY the request production sends (so the harness measures production)', async () => {
    mockFetch.mockResolvedValue({ ok: true, text: async () => JSON.stringify({ answers: {}, usage: {} }) });
    await classifyRecipe({ recipe });
    const sent = JSON.parse(mockFetch.mock.calls[0][1].body);
    const built = buildRequest('current', recipe);
    expect(sent.state).toEqual(built.state);
    expect(sent.questions).toEqual(built.questions);
    // key order matters too: it is the order Laya sees the questions in
    expect(Object.keys(sent.questions)).toEqual(Object.keys(built.questions));
  });

  it('never include servingTime or the answer, in any variant', () => {
    for (const id of VARIANT_IDS) {
      const req = buildRequest(id, recipe);
      expect(JSON.stringify(req)).not.toMatch(/servingTime/);
      // the recipe's own slot value must not appear in what describes the RECIPE
      // (slot names legitimately appear as the question's option text, so check `state` only)
      expect(JSON.stringify(req.state)).not.toMatch(/Breakfast/);
    }
  });

  it('keep the slot question keyed slot_fit with all seven slots as options', () => {
    for (const id of VARIANT_IDS) {
      const q = buildRequest(id, recipe).questions;
      expect(q.slot_fit.type).toBe('choice');
      expect(Object.keys(q.slot_fit.criteria)).toEqual(SLOT_KEYS);
    }
  });

  it('ask the protein question only where the variant says so', () => {
    const withProtein = VARIANT_IDS.filter((id) => 'protein_level' in buildRequest(id, recipe).questions);
    expect(withProtein).toEqual(['current', 'labels_protein']);
    expect(buildRequest('labels_protein', recipe).questions.protein_level).toEqual(buildProteinQuestion().protein_level);
  });

  it('strip the question text in steps: descriptions > few-word > bare names', () => {
    const len = (id) => JSON.stringify(buildRequest(id, recipe).questions.slot_fit).length;
    expect(len('no_protein')).toBeGreaterThan(len('short_desc'));
    expect(len('short_desc')).toBeGreaterThan(len('labels'));
    expect(buildRequest('labels', recipe).questions.slot_fit.criteria.dinner).toBe('Dinner');
    expect(buildRequest('short_desc', recipe).questions.slot_fit.criteria.dinner).toBe('an evening meal');
  });

  it('trim the recipe only where the variant says so', () => {
    expect(buildRequest('current', recipe).state.ingredients).toHaveLength(7);
    expect(buildRequest('labels_5ing', recipe).state.ingredients).toEqual(['Besan', 'Spinach', 'Onion', 'Green Chilli', 'Turmeric']);
    expect(buildRequest('labels_min', recipe).state).toEqual({ name: 'Palak Chilla', category: 'Indian' });
  });

  it('reject an unknown variant with the list of known ones', () => {
    expect(() => buildRequest('nope', recipe)).toThrow(/Unknown prompt variant "nope".*current/);
    expect(variantById('nope')).toBeNull();
  });
});

describe('askLaya', () => {
  it('sends an arbitrary request through the same fail-soft path', async () => {
    mockFetch.mockResolvedValue({ ok: true, text: async () => JSON.stringify({ model: 'm', answers: { a: 1 }, usage: { input_tokens: 99 } }) });
    const r = await askLaya({ state: { x: 1 }, questions: { q: { type: 'noul', instructions: 'ok?' } } });
    expect(r).toMatchObject({ ok: true, answers: { a: 1 }, usage: { input_tokens: 99 } });
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body).toMatchObject({ state: { x: 1 }, questions: { q: { type: 'noul' } } });
  });

  it('is disabled with Laya off, and never throws on a failure', async () => {
    config.laya.enabled = false;
    expect(await askLaya({ state: {}, questions: {} })).toEqual({ ok: false, reason: 'disabled' });
    config.laya.enabled = true;
    mockFetch.mockRejectedValue(new Error('down'));
    expect(await askLaya({ state: {}, questions: {} })).toMatchObject({ ok: false, reason: 'error' });
  });
});

// ---- analysis -----------------------------------------------------------

// A result row whose scores rank `top` first among the seven slots.
const row = (sourceSlot, topSlot, tokens, over = {}) => ({
  id: `${sourceSlot}-${topSlot}`,
  sourceSlot,
  slotProbs: Object.fromEntries(SLOT_KEYS.map((k) => [k, k === topSlot ? 0.7 : 0.05])),
  topSlot, // the real runner sets this on every answered row
  inputTokens: tokens,
  latencyMs: tokens * 29,
  ...over,
});

describe('summarizeVariant', () => {
  it('reports mean tokens, latency, rank metrics and the error count', () => {
    const results = [row('lunch', 'lunch', 100), row('dinner', 'dinner', 120), row('breakfast', 'lunch', 110), { sourceSlot: 'lunch', slotProbs: null, error: 'timeout', inputTokens: null, latencyMs: null }];
    const s = summarizeVariant(results);
    expect(s).toMatchObject({ n: 4, answered: 3, errors: 1, meanInputTokens: 110 });
    expect(s.top1).toBeCloseTo(2 / 3, 2);
    expect(s.latency.mean).toBe(3190);
    expect(s.protein).toBeNull(); // no protein answers in these rows
  });
  it('includes the protein check only when protein answers are present', () => {
    const withProtein = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((_, i) => row('lunch', 'lunch', 100, { proteinG: i * 4, protein: { choice: 'low', probabilities: { low: 0.8 - i * 0.1, moderate: 0.1, high: 0.1 + i * 0.1 } } }));
    expect(summarizeVariant(withProtein).protein.spearman).toBe(1);
  });
});

describe('compareVariants', () => {
  // Synthetic summaries: tokens, macro AUC
  const sum = (tokens, macroAuc, top1 = 0.3) => ({ meanInputTokens: tokens, macroAuc, top1, latency: { mean: tokens * 29 }, errors: 0 });

  it('recommends the cheapest variant within the tolerance of the best AUC', () => {
    const c = compareVariants({ current: sum(376, 0.75), no_protein: sum(238, 0.76), labels: sum(132, 0.74), labels_min: sum(81, 0.6) }, { tolerance: 0.03 });
    expect(c.bestAuc).toBe(0.76);
    expect(c.recommended).toBe('labels'); // 132 tokens at 0.74 is within 0.03 of 0.76; labels_min (0.60) is not
  });

  it('computes the change against the reference', () => {
    const c = compareVariants({ current: sum(400, 0.7, 0.3), labels: sum(100, 0.65, 0.25) });
    const labels = c.rows.find((r) => r.id === 'labels');
    expect(labels.dTokensPct).toBe(-75);
    expect(labels.dAuc).toBe(-0.05);
    expect(labels.dTop1).toBe(-0.05);
    expect(c.rows.find((r) => r.id === 'current').dTokensPct).toBe(0);
  });

  it('marks a variant dominated when another is no worse on both and better on one', () => {
    const c = compareVariants({ current: sum(376, 0.70), cheap_better: sum(150, 0.72), costly_worse: sum(300, 0.65) });
    expect(c.rows.find((r) => r.id === 'cheap_better').dominated).toBe(false);
    expect(c.rows.find((r) => r.id === 'current').dominated).toBe(true);
    expect(c.rows.find((r) => r.id === 'costly_worse').dominated).toBe(true);
  });

  it('lists but never recommends a variant with no AUC or no token count', () => {
    const c = compareVariants({ current: sum(376, 0.7), broken: { meanInputTokens: null, macroAuc: null, top1: null, latency: {}, errors: 70 } });
    expect(c.recommended).toBe('current');
    expect(c.rows.find((r) => r.id === 'broken').recommended).toBe(false);
    expect(compareVariants({}).recommended).toBeNull();
  });
});
