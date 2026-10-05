/**
 * Tests for the blind source-agreement smoke test (utils/layaSourceAgreement.js,
 * scripts/laya-source-agreement.js). Inline fixtures only: this is not
 * evaluation data, and the numbers it produces are agreement with existing
 * labels, not accuracy.
 */

const path = require('path');
const { execFile } = require('child_process');
const { SLOT_KEYS } = require('../utils/layaSlots');
const { runSourceAgreement, slotAgreement, slotYesRates, topPickConfusion, notRatedSuitable } = require('../utils/layaSourceAgreement');

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

  it('states loudly, in its own header, that this is not accuracy, and samples all seven slots', () => {
    const src = require('fs').readFileSync(path.join(__dirname, '..', 'scripts', 'laya-source-agreement.js'), 'utf8');
    expect(src).toMatch(/NOT accuracy/);
    expect(src).toMatch(/Neither is accuracy/);
    expect(src).toMatch(/servingTime: \{ \$in: SLOT_NAMES \}/);
  });
});
