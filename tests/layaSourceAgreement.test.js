/**
 * Tests for the blind source-agreement smoke test (utils/layaSourceAgreement.js,
 * scripts/laya-source-agreement.js). Inline fixtures only: this is not
 * evaluation data, and the numbers it produces are agreement with existing
 * labels, not accuracy.
 */

const path = require('path');
const { execFile } = require('child_process');
const { runSourceAgreement, perClassAgreement, disagreements } = require('../utils/layaSourceAgreement');

const item = (id, name, sourceMeal) => ({
  id, name, sourceMeal,
  recipe: { name, cuisine: null, category: null, ingredients: [{ name: 'x' }] }, // no servingTime, by construction
});
const ok = (choice, confidence = 0.4, latencyMs = 8000) => ({ ok: true, latencyMs, answers: { meal_type_fit: { type: 'choice', choice, confidence } } });
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
      return ok('breakfast');
    };
    const { results } = await runSourceAgreement({ items: [item('1', 'Poha', 'breakfast'), item('2', 'Dal', 'lunch'), item('3', 'Soup', 'dinner')], classify, sleep: noSleep });
    expect(results).toHaveLength(3);
    expect(peak).toBe(1);
    expect(seen.join('')).not.toMatch(/servingTime|sourceMeal|"lunch"|"dinner"/);
  });

  it('records the answer against the source slot, with confidence and latency', async () => {
    const { results } = await runSourceAgreement({ items: [item('1', 'Poha', 'breakfast')], classify: async () => ok('lunch', 0.35, 7100), sleep: noSleep });
    expect(results[0]).toMatchObject({ id: '1', expected: { meal_type: 'breakfast' }, predicted: { meal_type: 'lunch' }, confidence: 0.35, latencyMs: 7100, error: null, retries: 0 });
  });

  it('retries a refused (HTTP 503) request after a pause instead of counting it as a failure', async () => {
    const replies = [{ ok: false, reason: 'error', detail: 'HTTP 503 Service Unavailable - busy' }, { ok: false, reason: 'error', detail: 'HTTP 503 Service Unavailable - busy' }, ok('dinner')];
    const classify = jest.fn(async () => replies.shift());
    const { results, aborted } = await runSourceAgreement({ items: [item('1', 'Curry', 'dinner')], classify, sleep: noSleep, retryDelayMs: 3000 });
    expect(classify).toHaveBeenCalledTimes(3);
    expect(noSleep).toHaveBeenCalledWith(3000);
    expect(results[0]).toMatchObject({ predicted: { meal_type: 'dinner' }, error: null, retries: 2 });
    expect(aborted).toBeNull();
  });

  it('gives up on a request that stays busy, and does not retry timeouts or other errors', async () => {
    const busy = jest.fn(async () => ({ ok: false, reason: 'error', detail: 'HTTP 503 busy' }));
    const a = await runSourceAgreement({ items: [item('1', 'A', 'lunch')], classify: busy, sleep: noSleep, retries: 2 });
    expect(busy).toHaveBeenCalledTimes(3); // first try + 2 retries
    expect(a.results[0].error).toMatch(/503/);

    const timeout = jest.fn(async () => ({ ok: false, reason: 'timeout', detail: 'No response within 30000ms' }));
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
    for (let i = 0; i < 10; i += 1) flaky.mockResolvedValueOnce(i % 3 === 2 ? { ok: false, reason: 'timeout' } : ok('lunch'));
    const b = await runSourceAgreement({ items, classify: flaky, sleep: noSleep, maxConsecutiveFailures: 5 });
    expect(b.results).toHaveLength(10);
    expect(b.aborted).toBeNull();
  });

  it('reports progress after every recipe', async () => {
    const progress = jest.fn();
    await runSourceAgreement({ items: [item('1', 'A', 'lunch'), item('2', 'B', 'lunch')], classify: async () => ok('lunch'), sleep: noSleep, onProgress: progress });
    expect(progress.mock.calls.map((c) => [c[0], c[1]])).toEqual([[1, 2], [2, 2]]);
  });
});

describe('summaries', () => {
  const results = [
    { name: 'Poha', expected: { meal_type: 'breakfast' }, predicted: { meal_type: 'breakfast' }, confidence: 0.5 },
    { name: 'Upma', expected: { meal_type: 'breakfast' }, predicted: { meal_type: 'lunch' }, confidence: 0.3 },
    { name: 'Dal', expected: { meal_type: 'lunch' }, predicted: { meal_type: 'lunch' }, confidence: 0.6 },
    { name: 'Tea', expected: { meal_type: 'snack' }, predicted: null, error: 'timeout' }, // not answered: excluded
  ];

  it('computes per-slot agreement over answered recipes only', () => {
    expect(perClassAgreement(results)).toEqual({
      breakfast: { n: 2, agree: 1, rate: 0.5 },
      lunch: { n: 1, agree: 1, rate: 1 },
    });
  });

  it('lists disagreements with the existing slot, capped', () => {
    expect(disagreements(results)).toEqual([{ name: 'Upma', source: 'breakfast', laya: 'lunch', confidence: 0.3 }]);
    const many = Array.from({ length: 30 }, (_, i) => ({ name: `R${i}`, expected: { meal_type: 'lunch' }, predicted: { meal_type: 'dinner' }, confidence: null }));
    expect(disagreements(many, 5)).toHaveLength(5);
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

  it('states loudly, in its own header, that this is not accuracy', () => {
    const src = require('fs').readFileSync(path.join(__dirname, '..', 'scripts', 'laya-source-agreement.js'), 'utf8');
    expect(src).toMatch(/NOT accuracy/);
    expect(src).toMatch(/Neither is accuracy/);
  });
});
