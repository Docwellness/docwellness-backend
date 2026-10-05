/**
 * Shadow mode must be invisible to callers: no-op unless fully enabled,
 * fire-and-forget, and unable to throw or delay the flow it shadows.
 */

jest.mock('../models/GenerationLog', () => ({ create: jest.fn() }));

const config = require('../config/environment');
const GenerationLog = require('../models/GenerationLog');
const { runShadow, surfaceEnabled } = require('../services/layaShadowService');

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

  it('records a timeout as a failed shadow row', async () => {
    runShadow({ ...base, call: jest.fn().mockResolvedValue({ ok: false, reason: 'timeout' }) });
    await flush();
    expect(GenerationLog.create.mock.calls[0][0]).toMatchObject({ layaTimedOut: true, succeeded: false, layaLatencyMs: null });
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
