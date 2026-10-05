/**
 * Tests for the blind source-agreement smoke test (utils/layaSourceAgreement.js,
 * scripts/laya-source-agreement.js). Inline fixtures only: this is not
 * evaluation data, and the numbers it produces are agreement with existing
 * labels, not accuracy.
 */

const path = require('path');
const { execFile } = require('child_process');
const { SLOT_KEYS } = require('../utils/layaSlots');
const { runSourceAgreement, slotAgreement, slotYesRates, topPickConfusion, notRatedSuitable, rankSummary } = require('../utils/layaSourceAgreement');

const item = (id, name, sourceSlot) => ({
  id, name, sourceSlot,
  recipe: { name, cuisine: null, category: null, ingredients: [{ name: 'x' }] }, // no servingTime, by construction
});
// A Laya reply: yes (0.9) for the named slots, no (0.1) for the rest.
const reply = (yesSlots = [], latencyMs = 9000) => ({
  ok: true,
  latencyMs,
  answers: Object.fromEntries(SLOT_KEYS.map((k) => [`slot_${k}`, { type: 'noul', noul: yesSlots.includes(k) ? 0.9 : 0.1 }])),
});
// The one-question form: a probability per slot summing to 1, `top` highest.
const choiceReply = (top, second = null, latencyMs = 4000, high = 0.6) => {
  const probabilities = Object.fromEntries(SLOT_KEYS.map((k) => [k, 0.03]));
  probabilities[top] = 0.6;
  if (second) probabilities[second] = 0.25;
  return {
    ok: true,
    latencyMs,
    answers: {
      slot_fit: { type: 'choice', choice: top, confidence: 0.4, probabilities },
      protein_level: { type: 'choice', choice: high > 0.5 ? 'high' : 'low', confidence: 0.3, probabilities: { low: Number((0.9 - high).toFixed(2)), moderate: 0.1, high } },
    },
  };
};
const noSleep = jest.fn(async () => {});

beforeEach(() => noSleep.mockClear());

describe('runSourceAgreement', () => {
  it('asks Laya one recipe at a time, and never hands it the source slot', async () => {
    let inFlight = 0;
    let peak = 0;
    const seen = [];
    const classify = async (arg) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      seen.push(JSON.stringify(arg));
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return reply(['breakfast']);
    };
    const { results } = await runSourceAgreement({ items: [item('1', 'Poha', 'breakfast'), item('2', 'Dal', 'lunch'), item('3', 'Soup', 'dinner')], classify, sleep: noSleep });
    expect(results).toHaveLength(3);
    expect(peak).toBe(1);
    expect(seen.join('')).not.toMatch(/servingTime|sourceSlot|"lunch"|"dinner"/);
  });

  it('records the per-slot probabilities, the top pick and the latency against the source slot', async () => {
    const { results } = await runSourceAgreement({ items: [item('1', 'Poha', 'breakfast')], classify: async () => reply(['brunch', 'breakfast'], 11200), sleep: noSleep });
    expect(results[0]).toMatchObject({ id: '1', sourceSlot: 'breakfast', topSlot: 'breakfast', latencyMs: 11200, error: null, retries: 0 });
    expect(results[0].slotProbs).toMatchObject({ breakfast: 0.9, brunch: 0.9, lunch: 0.1 });
  });

  it('records the input token count Laya reports for each call (for the prompt ablation)', async () => {
    const withUsage = { ...reply(['lunch']), usage: { input_tokens: 123, output_tokens: 0 } };
    const { results } = await runSourceAgreement({ items: [item('1', 'Dal', 'lunch'), item('2', 'Poha', 'breakfast')], classify: jest.fn().mockResolvedValueOnce(withUsage).mockResolvedValueOnce(reply(['breakfast'])), sleep: noSleep });
    expect(results[0].inputTokens).toBe(123);
    expect(results[1].inputTokens).toBeNull(); // no usage reported: null, not a guess
  });

  it('retries a refused (HTTP 503) request after a pause instead of counting it as a failure', async () => {
    const replies = [{ ok: false, reason: 'error', detail: 'HTTP 503 Service Unavailable - busy' }, { ok: false, reason: 'error', detail: 'HTTP 503 Service Unavailable - busy' }, reply(['dinner'])];
    const classify = jest.fn(async () => replies.shift());
    const { results, aborted } = await runSourceAgreement({ items: [item('1', 'Curry', 'dinner')], classify, sleep: noSleep, retryDelayMs: 3000 });
    expect(classify).toHaveBeenCalledTimes(3);
    expect(noSleep).toHaveBeenCalledWith(3000);
    expect(results[0]).toMatchObject({ topSlot: 'dinner', error: null, retries: 2 });
    expect(aborted).toBeNull();
  });

  it('gives up on a request that stays busy, and does not retry timeouts or other errors', async () => {
    const busy = jest.fn(async () => ({ ok: false, reason: 'error', detail: 'HTTP 503 busy' }));
    const a = await runSourceAgreement({ items: [item('1', 'A', 'lunch')], classify: busy, sleep: noSleep, retries: 2 });
    expect(busy).toHaveBeenCalledTimes(3); // first try + 2 retries
    expect(a.results[0].error).toMatch(/503/);

    const timeout = jest.fn(async () => ({ ok: false, reason: 'timeout', detail: 'No response within 60000ms' }));
    await runSourceAgreement({ items: [item('1', 'A', 'lunch')], classify: timeout, sleep: noSleep });
    expect(timeout).toHaveBeenCalledTimes(1);
  });

  it('stops when calls keep failing, but not on scattered failures', async () => {
    const dead = jest.fn(async () => ({ ok: false, reason: 'error', detail: 'fetch failed (ECONNREFUSED)' }));
    const items = Array.from({ length: 10 }, (_, i) => item(String(i), `R${i}`, 'lunch'));
    const a = await runSourceAgreement({ items, classify: dead, sleep: noSleep, maxConsecutiveFailures: 5 });
    expect(a.results).toHaveLength(5);
    expect(a.aborted).toMatch(/5 calls in a row failed.*ECONNREFUSED/);

    const flaky = jest.fn();
    for (let i = 0; i < 10; i += 1) flaky.mockResolvedValueOnce(i % 3 === 2 ? { ok: false, reason: 'timeout' } : reply(['lunch']));
    const b = await runSourceAgreement({ items, classify: flaky, sleep: noSleep, maxConsecutiveFailures: 5 });
    expect(b.results).toHaveLength(10);
    expect(b.aborted).toBeNull();
  });

  it('reports progress after every recipe', async () => {
    const progress = jest.fn();
    await runSourceAgreement({ items: [item('1', 'A', 'lunch'), item('2', 'B', 'lunch')], classify: async () => reply(['lunch']), sleep: noSleep, onProgress: progress });
    expect(progress.mock.calls.map((c) => [c[0], c[1]])).toEqual([[1, 2], [2, 2]]);
  });
});

describe('summaries', () => {
  const run = async (specs) => {
    const items = specs.map(([name, source]) => item(name, name, source));
    const replies = specs.map(([, , yes]) => (yes === null ? { ok: false, reason: 'timeout' } : reply(yes)));
    return (await runSourceAgreement({ items, classify: async () => replies.shift(), sleep: noSleep })).results;
  };

  it('rates whether the existing slot is suitable, whether it is the top pick, and how many slots get a yes', async () => {
    const results = await run([
      ['Poha', 'breakfast', ['breakfast', 'brunch']], // suitable, top pick is breakfast (earlier slot wins the tie)
      ['Upma', 'breakfast', ['lunch']], // existing slot NOT rated suitable
      ['Dal', 'lunch', ['lunch', 'dinner']], // suitable, top pick lunch
      ['Tea', 'night_drink', null], // not answered: excluded
    ]);
    const a = slotAgreement(results);
    expect(a).toMatchObject({ n: 3, ratedSuitable: 2, suitableRate: 0.667, topIsSource: 2, topRate: 0.667, meanSlotsRatedSuitable: 1.67, maxSlots: 7 });
    expect(a.bySlot.breakfast).toMatchObject({ n: 2, ratedSuitable: 1, topIsSource: 1, suitableRate: 0.5 });
    expect(a.bySlot.lunch).toMatchObject({ n: 1, ratedSuitable: 1 });
    expect(a.bySlot.night_drink).toBeUndefined();
  });

  it('shows "yes to everything" as perfect suitability but no discrimination', async () => {
    const results = await run([['A', 'lunch', SLOT_KEYS], ['B', 'dinner', SLOT_KEYS]]);
    const a = slotAgreement(results);
    expect(a.suitableRate).toBe(1);
    expect(a.meanSlotsRatedSuitable).toBe(7);
  });

  it('counts how often Laya says yes to each slot', async () => {
    const results = await run([['A', 'lunch', ['lunch', 'dinner']], ['B', 'lunch', ['lunch']]]);
    const y = slotYesRates(results);
    expect(y.lunch).toEqual({ yes: 2, n: 2, rate: 1 });
    expect(y.dinner).toEqual({ yes: 1, n: 2, rate: 0.5 });
    expect(y.morning_drink.yes).toBe(0);
  });

  it('tabulates existing slot -> top pick and lists recipes whose existing slot is not rated suitable', async () => {
    const results = await run([['Poha', 'breakfast', ['breakfast']], ['Upma', 'breakfast', ['lunch']], ['Dal', 'dinner', ['lunch']]]);
    expect(topPickConfusion(results)).toEqual({ 'breakfast -> breakfast': 1, 'breakfast -> lunch': 1, 'dinner -> lunch': 1 });
    const bad = notRatedSuitable(results);
    expect(bad.map((d) => d.name)).toEqual(['Upma', 'Dal']);
    expect(bad[0]).toMatchObject({ source: 'breakfast', laysTop: 'lunch', pSource: 0.1, pTop: 0.9 });
    expect(notRatedSuitable(results, 1)).toHaveLength(1);
  });
});

describe('rankSummary (threshold-free, works for both answer forms)', () => {
  const runWith = async (specs, make) => {
    const items = specs.map(([name, source]) => item(name, name, source));
    const replies = specs.map((s) => make(s));
    return (await runSourceAgreement({ items, classify: async () => replies.shift(), sleep: noSleep })).results;
  };

  it('scores the one-question form by where the existing slot ranks, with chance levels', async () => {
    const results = await runWith(
      [['Poha', 'breakfast', 'breakfast', null], ['Dal', 'lunch', 'dinner', 'lunch'], ['Tea', 'night_drink', 'morning_drink', null]],
      ([, , top, second]) => choiceReply(top, second)
    );
    expect(results.every((r) => r.slotMode === 'choice')).toBe(true);
    const r = rankSummary(results);
    expect(r.n).toBe(3);
    // Poha: rank 1; Dal: lunch is 2nd; Tea: night_drink tied low with four others -> rank 5
    expect(r.meanBestAcceptedRank).toBeCloseTo((1 + 2 + 4.5) / 3, 1);
    expect(r.chanceMeanBestRank).toBe(4);
    expect(r.topK[1]).toMatchObject({ hit: 1, chance: 0.143 });
    expect(r.topK[2].hit).toBe(2);
  });

  it('reads the seven-yes/no form too, and detects which form was used', async () => {
    const results = await runWith([['A', 'lunch', ['lunch']], ['B', 'dinner', ['dinner']]], ([, , yes]) => reply(yes));
    expect(results.every((r) => r.slotMode === 'noul')).toBe(true);
    expect(rankSummary(results).topK[1].rate).toBe(1);
  });
});

describe('scripts/laya-source-agreement.js', () => {
  it('refuses to run when Laya is not enabled (before touching the database)', async () => {
    const r = await new Promise((resolve) => {
      execFile(process.execPath, [path.join(__dirname, '..', 'scripts', 'laya-source-agreement.js'), '--yes'],
        { env: { ...process.env, OPENAI_API_KEY: 'dummy', LAYA_ENABLED: 'false' }, cwd: path.join(__dirname, '..') },
        (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stderr }));
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/LAYA_ENABLED=true/);
  });

  it('re-analyses a saved results file without Laya or the database (--from)', async () => {
    const fs = require('fs');
    const os = require('os');
    // eight recipes so the protein check has enough rows; Laya's protein score rises with the grams
    const specs = [['Poha', 'breakfast', 2, 0.1], ['Dal', 'lunch', 6, 0.2], ['Tea', 'night_drink', 1, 0.05], ['Curry', 'dinner', 20, 0.7],
      ['Soup', 'dinner', 9, 0.3], ['Chaat', 'evening_snack', 11, 0.4], ['Egg', 'breakfast', 25, 0.8], ['Fish', 'lunch', 30, 0.9]];
    const items = specs.map(([n, s, g]) => ({ ...item(n, n, s), proteinG: g }));
    const replies = specs.map(([, s, , h], i) => (i === 1 ? choiceReply('dinner', 'lunch', 4000, h) : choiceReply(s, null, 4000, h)));
    const { results } = await runSourceAgreement({ items, classify: async () => replies.shift(), sleep: noSleep });
    expect(results[3].proteinG).toBe(20); // carried through for the protein check
    expect(results[3].protein.probabilities.high).toBe(0.7);
    const file = path.join(os.tmpdir(), `sa-${Date.now()}.json`);
    fs.writeFileSync(file, JSON.stringify({ results }));
    const r = await new Promise((resolve) => {
      execFile(process.execPath, [path.join(__dirname, '..', 'scripts', 'laya-source-agreement.js'), `--from=${file}`],
        // deliberately no Laya settings and no usable database: --from must need neither
        { env: { ...process.env, OPENAI_API_KEY: 'dummy', LAYA_ENABLED: 'false', MONGODB_URI: 'mongodb://127.0.0.1:1/none' }, cwd: path.join(__dirname, '..') },
        (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }));
    });
    fs.rmSync(file, { force: true });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/Re-analysing 8 saved results/);
    expect(r.stdout).toMatch(/one 7-option question/);
    expect(r.stdout).toMatch(/Existing slot in Laya's top 1: 7\/8 = 88%\s+\(chance 14%\)/); // only Dal (a decoy 'dinner' top pick) misses
    // the protein check rides along: Laya's score is monotone in the grams here
    expect(r.stdout).toMatch(/protein_level vs the nutrition data/);
    expect(r.stdout).toMatch(/recipes with both Laya's protein answer and grams: 8/);
    expect(r.stdout).toMatch(/Spearman rank correlation: 1 /);
    expect(r.stdout).toMatch(/NOT accuracy/);
    expect(r.stdout).not.toMatch(/Thresholded yes\/no view/); // not meaningful for the choice form
  });

  it('states loudly, in its own header, that this is not accuracy, and samples all seven slots', () => {
    const src = require('fs').readFileSync(path.join(__dirname, '..', 'scripts', 'laya-source-agreement.js'), 'utf8');
    expect(src).toMatch(/NOT accuracy/);
    expect(src).toMatch(/Agreement with existing labels, NOT accuracy/);
    expect(src).toMatch(/servingTime: \{ \$in: SLOT_NAMES \}/);
  });
});
