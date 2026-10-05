/**
 * Shadow mode must be invisible to callers: no-op unless fully enabled,
 * fire-and-forget, and unable to throw or delay the flow it shadows.
 */

jest.mock('../models/GenerationLog', () => ({ create: jest.fn() }));

const config = require('../config/environment');
const GenerationLog = require('../models/GenerationLog');
const { runShadow, surfaceEnabled, _inFlightForTests } = require('../services/layaShadowService');

const flush = () => new Promise((r) => setImmediate(r));
const base = { surface: 'recipe_classification', kind: 'recipe', inputHash: 'h', reference: { servingTime: 'Breakfast' } };
const okResult = {
  ok: true,
  latencyMs: 640,
  answers: { meal_type_fit: { type: 'choice', choice: 'breakfast', confidence: 0.35 }, protein_level: { type: 'choice', choice: 'low', confidence: 0.2 } },
};

beforeEach(() => {
  GenerationLog.create.mockReset().mockResolvedValue({});
  config.laya.enabled = true;
  config.laya.mode = 'shadow';
  config.laya.shadowSurfaces = ['recipe_classification'];
  config.laya.shadowMaxInFlight = 2;
});

describe('runShadow gating', () => {
  it.each([
    ['LAYA_ENABLED=false', () => { config.laya.enabled = false; }],
    ["LAYA_MODE='off'", () => { config.laya.mode = 'off'; }],
    ["LAYA_MODE='live' (shadow runner never runs live)", () => { config.laya.mode = 'live'; }],
    ['surface not listed', () => { config.laya.shadowSurfaces = ['diet_plan_review']; }],
    ['no surfaces configured', () => { config.laya.shadowSurfaces = []; }],
  ])('does not call Laya or write a log when %s', async (_n, arrange) => {
    arrange();
    const call = jest.fn().mockResolvedValue(okResult);
    expect(runShadow({ ...base, call })).toBeUndefined();
    await flush();
    expect(call).not.toHaveBeenCalled();
    expect(GenerationLog.create).not.toHaveBeenCalled();
  });

  it('surfaceEnabled reflects all three switches', () => {
    expect(surfaceEnabled('recipe_classification')).toBe(true);
    expect(surfaceEnabled('other')).toBe(false);
  });
});

describe('runShadow when enabled', () => {
  it('logs the answer with the existing flow\'s value alongside, min confidence, and no request text', async () => {
    runShadow({ ...base, dieticianId: 'd1', call: jest.fn().mockResolvedValue(okResult) });
    await flush();
    expect(GenerationLog.create).toHaveBeenCalledTimes(1);
    const row = GenerationLog.create.mock.calls[0][0];
    expect(row).toMatchObject({
      kind: 'recipe', dieticianId: 'd1', layaMode: 'shadow', layaSurface: 'recipe_classification',
      layaLatencyMs: 640, layaConfidence: 0.2, layaTimedOut: false, succeeded: true,
    });
    expect(row.layaDecisions.answers.meal_type_fit.choice).toBe('breakfast');
    expect(row.layaDecisions.reference).toEqual({ servingTime: 'Breakfast' });
  });

  it('records the backend request id and the Laya model on the row', async () => {
    config.laya.model = 'laya-typed-decisions';
    runShadow({ ...base, requestId: 'abc123def456', call: jest.fn().mockResolvedValue({ ...okResult, model: 'laya-rl-agent' }) });
    runShadow({ ...base, call: jest.fn().mockResolvedValue(okResult) });
    await flush();
    const [withId, withoutId] = GenerationLog.create.mock.calls.map((c) => c[0]);
    expect(withId).toMatchObject({ requestId: 'abc123def456', model: 'laya-typed-decisions' });
    expect(withId.layaDecisions.servedModel).toBe('laya-rl-agent');
    expect(withoutId.requestId).toBeNull();
    expect(withoutId.layaDecisions.servedModel).toBeNull();
  });

  it('records a timeout as a failed shadow row', async () => {
    runShadow({ ...base, call: jest.fn().mockResolvedValue({ ok: false, reason: 'timeout' }) });
    await flush();
    expect(GenerationLog.create.mock.calls[0][0]).toMatchObject({ layaTimedOut: true, succeeded: false, layaLatencyMs: null });
  });

  it('records why a failed call failed (reason + detail), and null on success', async () => {
    runShadow({ ...base, call: jest.fn().mockResolvedValue({ ok: false, reason: 'error', detail: 'fetch failed (ENOTFOUND)' }) });
    runShadow({ ...base, call: jest.fn().mockResolvedValue(okResult) });
    await flush();
    expect(GenerationLog.create.mock.calls[0][0].layaError).toEqual({ reason: 'error', detail: 'fetch failed (ENOTFOUND)' });
    expect(GenerationLog.create.mock.calls[1][0].layaError).toBeNull();
  });

  it('truncates a very long error detail', async () => {
    runShadow({ ...base, call: jest.fn().mockResolvedValue({ ok: false, reason: 'error', detail: 'x'.repeat(5000) }) });
    await flush();
    expect(GenerationLog.create.mock.calls[0][0].layaError.detail).toHaveLength(300);
  });

  it('returns before a slow Laya call resolves (never delays the caller)', async () => {
    let release;
    const call = jest.fn(() => new Promise((r) => { release = () => r(okResult); }));
    const start = Date.now();
    runShadow({ ...base, call });
    expect(Date.now() - start).toBeLessThan(20);
    expect(GenerationLog.create).not.toHaveBeenCalled();
    release();
    await flush();
    expect(GenerationLog.create).toHaveBeenCalled();
  });
});

describe('runShadow failure isolation', () => {
  let warn;
  beforeEach(() => { warn = jest.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => warn.mockRestore());

  it('swallows a rejecting Laya call', async () => {
    expect(() => runShadow({ ...base, call: jest.fn().mockRejectedValue(new Error('boom')) })).not.toThrow();
    await flush();
    expect(warn).toHaveBeenCalled();
  });

  it('swallows a call that throws synchronously', async () => {
    expect(() => runShadow({ ...base, call: () => { throw new Error('sync'); } })).not.toThrow();
    await flush();
  });

  it('swallows a Mongo write failure (no unhandled rejection)', async () => {
    GenerationLog.create.mockRejectedValue(new Error('mongo down'));
    expect(() => runShadow({ ...base, call: jest.fn().mockResolvedValue(okResult) })).not.toThrow();
    await flush();
    expect(warn).toHaveBeenCalled();
  });

  it('tolerates missing/garbage options', () => {
    expect(() => runShadow()).not.toThrow();
    expect(() => runShadow(null)).not.toThrow();
    expect(() => runShadow({ surface: 'recipe_classification' })).not.toThrow();
  });
});

describe('runShadow in-flight cap (Laya serves one request at a time)', () => {
  // A Laya call we control: resolves only when released.
  const controllable = () => {
    let release;
    const call = jest.fn(() => new Promise((r) => { release = () => r(okResult); }));
    return { call, release: () => release() };
  };

  it('calls Laya for at most the cap, and records the rest as skipped without calling Laya', async () => {
    const calls = [controllable(), controllable(), controllable(), controllable()];
    calls.forEach((c, i) => runShadow({ ...base, requestId: `r${i}`, call: c.call }));
    await flush();

    expect(calls.map((c) => c.call.mock.calls.length)).toEqual([1, 1, 0, 0]); // 3rd and 4th never reach Laya
    expect(_inFlightForTests()).toBe(2);

    const skipped = GenerationLog.create.mock.calls.map((c) => c[0]).filter((r) => r.layaError && r.layaError.reason === 'skipped');
    expect(skipped).toHaveLength(2);
    expect(skipped[0]).toMatchObject({ layaMode: 'shadow', layaSurface: 'recipe_classification', succeeded: false, requestId: 'r2' });
    expect(skipped[0].layaDecisions.reference).toEqual({ servingTime: 'Breakfast' });
    expect(skipped[0].layaDecisions.answers).toBeUndefined();

    calls[0].release();
    calls[1].release();
    await flush();
    expect(_inFlightForTests()).toBe(0);
  });

  it('frees a slot as soon as the Laya call returns, so later calls go through again', async () => {
    const a = controllable();
    const b = controllable();
    const c = controllable();
    runShadow({ ...base, call: a.call });
    runShadow({ ...base, call: b.call });
    await flush();
    a.release();
    await flush();
    runShadow({ ...base, call: c.call }); // slot freed by a
    await flush();
    expect(c.call).toHaveBeenCalledTimes(1);
    b.release();
    c.release();
    await flush();
    expect(_inFlightForTests()).toBe(0);
  });

  it('releases the slot even when the Laya call rejects or throws', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    runShadow({ ...base, call: jest.fn().mockRejectedValue(new Error('boom')) });
    runShadow({ ...base, call: () => { throw new Error('sync'); } });
    await flush();
    expect(_inFlightForTests()).toBe(0);
    warn.mockRestore();
  });

  it('releases the slot before the database write finishes', async () => {
    let finishWrite;
    GenerationLog.create.mockImplementationOnce(() => new Promise((r) => { finishWrite = () => r({}); }));
    runShadow({ ...base, call: jest.fn().mockResolvedValue(okResult) });
    await flush();
    expect(_inFlightForTests()).toBe(0); // Laya is idle even though the write is still pending
    finishWrite();
    await flush();
  });

  it('honours a configured cap and falls back to 2 on a bad value', async () => {
    config.laya.shadowMaxInFlight = 1;
    const a = controllable();
    const b = controllable();
    runShadow({ ...base, call: a.call });
    runShadow({ ...base, call: b.call });
    await flush();
    expect(b.call).not.toHaveBeenCalled();
    a.release();
    await flush();

    config.laya.shadowMaxInFlight = 'nonsense';
    const c = [controllable(), controllable(), controllable()];
    c.forEach((x) => runShadow({ ...base, call: x.call }));
    await flush();
    expect(c.map((x) => x.call.mock.calls.length)).toEqual([1, 1, 0]);
    c[0].release();
    c[1].release();
    await flush();
  });

  it('a failed skip-record write does not throw or leak a slot', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    GenerationLog.create.mockRejectedValue(new Error('mongo down'));
    const a = controllable();
    const b = controllable();
    runShadow({ ...base, call: a.call });
    runShadow({ ...base, call: b.call });
    expect(() => runShadow({ ...base, call: jest.fn() })).not.toThrow(); // over the cap -> skip path
    await flush();
    a.release();
    b.release();
    await flush();
    expect(_inFlightForTests()).toBe(0);
    warn.mockRestore();
  });
});
