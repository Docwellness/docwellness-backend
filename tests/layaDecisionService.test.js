/**
 * Stage A tests for services/layaDecisionService.js - see
 * docs/laya-architecture.md. Two things matter here: (1) every exported
 * function is fail-safe (never throws, always returns an { ok } shape) so a
 * future live call site never needs a try/catch to stay safe, and (2)
 * nothing under controllers/ or routes/ imports this service yet - the
 * Stage A invariant that no live traffic path has been touched.
 */

const fs = require('fs');
const path = require('path');

const realFetch = global.fetch;
const mockFetch = jest.fn();
global.fetch = mockFetch;
afterAll(() => {
  global.fetch = realFetch;
});

const config = require('../config/environment');
const {
  classifyRecipe,
  scoreRecipe,
  checkRecipeCompatibility,
  classifyUserIntent,
  shouldRegenerate,
  requiresDieticianReview,
} = require('../services/layaDecisionService');

const recipe = {
  name: 'Paneer Butter Masala',
  cuisine: 'North Indian',
  category: 'High Protein',
  servingTime: 'Dinner',
  ingredients: [{ name: 'Paneer' }, { name: 'Tomato' }, { name: 'Butter' }],
};

beforeEach(() => {
  mockFetch.mockReset();
  config.laya.enabled = false;
  config.laya.baseUrl = 'http://laya.internal:8080';
  config.laya.apiKey = 'test-key';
  config.laya.model = 'laya-typed-decisions';
  config.laya.timeoutMs = 50;
});

describe('layaDecisionService - LAYA_ENABLED=false (default)', () => {
  it('classifyRecipe resolves disabled without calling fetch', async () => {
    const result = await classifyRecipe({ recipe });
    expect(result).toEqual({ ok: false, reason: 'disabled' });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('scoreRecipe resolves disabled without calling fetch', async () => {
    const result = await scoreRecipe({ recipe, criteria: 'fit for a keto plan?' });
    expect(result).toEqual({ ok: false, reason: 'disabled' });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('checkRecipeCompatibility resolves disabled without calling fetch', async () => {
    const result = await checkRecipeCompatibility({ recipe, userProfile: {} });
    expect(result).toEqual({ ok: false, reason: 'disabled' });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('classifyUserIntent resolves disabled without calling fetch', async () => {
    const result = await classifyUserIntent({ text: 'give me a diet plan' });
    expect(result).toEqual({ ok: false, reason: 'disabled' });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('shouldRegenerate resolves disabled without calling fetch', async () => {
    const result = await shouldRegenerate({ validationSummary: 'severe calorie miss' });
    expect(result).toEqual({ ok: false, reason: 'disabled' });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('requiresDieticianReview resolves disabled without calling fetch', async () => {
    const result = await requiresDieticianReview({ decisionSummary: 'borderline plan' });
    expect(result).toEqual({ ok: false, reason: 'disabled' });
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('layaDecisionService - LAYA_ENABLED=true', () => {
  beforeEach(() => {
    config.laya.enabled = true;
  });

  it('returns a config error and never calls fetch when baseUrl/apiKey are missing', async () => {
    config.laya.baseUrl = undefined;
    const result = await classifyRecipe({ recipe });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('error');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('times out and resolves { ok: false, reason: "timeout" } without throwing', async () => {
    mockFetch.mockImplementation(
      (_url, { signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        })
    );

    const result = await classifyRecipe({ recipe });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('timeout');
  });

  it('resolves { ok: false, reason: "error" } on a non-OK HTTP response, never throws', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      text: async () => 'boom',
    });

    const result = await classifyRecipe({ recipe });
    expect(result).toEqual({
      ok: false,
      reason: 'error',
      detail: expect.stringContaining('HTTP 500'),
    });
  });

  it('resolves { ok: false, reason: "error" } on a network rejection, never throws', async () => {
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await classifyRecipe({ recipe });
    expect(result).toEqual({ ok: false, reason: 'error', detail: 'ECONNREFUSED' });
  });

  it('includes the underlying network error code (Node fetch hides it in err.cause)', async () => {
    const err = new TypeError('fetch failed');
    err.cause = Object.assign(new Error('getaddrinfo ENOTFOUND laya'), { code: 'ENOTFOUND' });
    mockFetch.mockRejectedValue(err);

    const result = await classifyRecipe({ recipe });
    expect(result).toEqual({ ok: false, reason: 'error', detail: 'fetch failed (ENOTFOUND)' });
  });

  it('parses a successful response and posts to /v1/systemone with bearer auth', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      text: async () =>
        JSON.stringify({
          model: 'laya-rl-agent',
          answers: { meal_type_fit: 'dinner', protein_level: 'high' },
          usage: { input_tokens: 42, output_tokens: 8 },
        }),
    });

    const result = await classifyRecipe({ recipe });

    expect(result.ok).toBe(true);
    expect(result.answers).toEqual({ meal_type_fit: 'dinner', protein_level: 'high' });
    expect(result.model).toBe('laya-rl-agent'); // the checkpoint Laya actually served
    expect(typeof result.latencyMs).toBe('number');

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, requestInit] = mockFetch.mock.calls[0];
    expect(url).toBe('http://laya.internal:8080/v1/systemone');
    expect(requestInit.method).toBe('POST');
    expect(requestInit.headers.Authorization).toBe('Bearer test-key');
    const body = JSON.parse(requestInit.body);
    expect(body.model).toBe('laya-typed-decisions');
    expect(body.questions).toHaveProperty('meal_type_fit');
    expect(body.questions).toHaveProperty('protein_level');
  });
});

describe('Stage B shadow-wiring invariant', () => {
  // Only these two call sites may use Laya, and only through runShadow
  // (services/layaShadowService.js): never awaited, never feeding a response.
  const ALLOWED = [
    'controllers/dietician/dietPlanController.js',
    'controllers/dietician/uploadRecipieController.js',
  ];

  const walk = (dir) =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]
    );
  const root = path.join(__dirname, '..');
  const files = ['controllers', 'routes']
    .flatMap((d) => walk(path.join(root, d)))
    .filter((f) => f.endsWith('.js'))
    .map((f) => ({ rel: path.relative(root, f).split(path.sep).join('/'), src: fs.readFileSync(f, 'utf8') }));

  it('only the two shadow call sites import layaDecisionService', () => {
    const importers = files.filter((f) => f.src.includes('layaDecisionService')).map((f) => f.rel).sort();
    expect(importers).toEqual([...ALLOWED].sort());
  });

  it('those call sites use it only inside runShadow and never await a Laya call', () => {
    for (const rel of ALLOWED) {
      const { src } = files.find((f) => f.rel === rel);
      expect(src).toContain('runShadow(');
      expect(src).not.toMatch(/await\s+(runShadow|classifyRecipe|requiresDieticianReview|shouldRegenerate|scoreRecipe|checkRecipeCompatibility)/);
    }
  });
});
