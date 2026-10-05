/**
 * Tests for the Laya load-test tooling (utils/layaLoadTest.js and
 * scripts/laya-load-test.js). The end-to-end block runs the real script
 * against a fake Laya (which sheds load with HTTP 503 past 3 concurrent
 * requests, like Laya's LAYA_MAX_CONCURRENT) and a fake backend /health.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFile } = require('child_process');

const {
  loadRecipes,
  parseMix,
  buildRequest,
  classifyOutcome,
  runPool,
  summarizeStage,
  startProbe,
  shouldAbort,
} = require('../utils/layaLoadTest');

describe('parseMix', () => {
  it('produces an exact, interleaved schedule', () => {
    const m = parseMix('recipe:80,review:20');
    expect(m).toHaveLength(100);
    expect(m.filter((k) => k === 'review')).toHaveLength(20);
    // interleaved: no long clump of reviews
    expect(m.join(',')).not.toMatch(/review,review,review/);
  });
  it('rejects unknown kinds and bad weights', () => {
    expect(() => parseMix('bogus:1')).toThrow(/Bad --mix/);
    expect(() => parseMix('recipe:0')).toThrow(/Bad --mix/);
    expect(() => parseMix('recipe:x')).toThrow(/Bad --mix/);
  });
});

describe('payloads', () => {
  it('falls back to built-in recipes and normalises ingredient shapes', () => {
    const recipes = loadRecipes(null);
    expect(recipes.length).toBeGreaterThan(0);
    expect(recipes[0].ingredients[0]).toEqual({ name: expect.any(String) });
  });
  it('accepts review-sheet rows ({ input: { recipe } }) and plain recipes', () => {
    const r = loadRecipes([
      { input: { recipe: { name: 'A', ingredients: [{ name: 'x' }] } } },
      { name: 'B', ingredients: ['y', 'z'] },
    ]);
    expect(r.map((x) => x.name)).toEqual(['A', 'B']);
    expect(r[1].ingredients).toEqual([{ name: 'y' }, { name: 'z' }]);
  });
  it('builds requests for the real service functions', () => {
    const recipes = loadRecipes(null);
    expect(buildRequest('recipe', 0, recipes).fn).toBe('classifyRecipe');
    expect(buildRequest('compat', 0, recipes).fn).toBe('checkRecipeCompatibility');
    const review = buildRequest('review', 0, recipes);
    expect(review.fn).toBe('requiresDieticianReview');
    // the largest summary the app can actually produce is ~2 KB
    expect(JSON.stringify(review.args).length).toBeGreaterThan(1500);
    expect(JSON.stringify(review.args).length).toBeLessThan(3000);
  });
});

describe('classifyOutcome', () => {
  it('separates ok / timeout / overload (503) / error', () => {
    expect(classifyOutcome({ ok: true })).toEqual({ ok: true });
    expect(classifyOutcome({ ok: false, reason: 'timeout', detail: 'No response within 3000ms' })).toMatchObject({ kind: 'timeout' });
    expect(classifyOutcome({ ok: false, reason: 'error', detail: 'HTTP 503 Service Unavailable - busy' })).toMatchObject({ kind: 'overload' });
    expect(classifyOutcome({ ok: false, reason: 'error', detail: 'fetch failed (ECONNREFUSED)' })).toMatchObject({ kind: 'error' });
    expect(classifyOutcome(undefined)).toMatchObject({ ok: false, kind: 'error' });
  });
});

describe('runPool', () => {
  it('never exceeds the requested concurrency, and does reach it', async () => {
    let inFlight = 0;
    let maxSeen = 0;
    const { outcomes, peakInFlight } = await runPool({
      total: 20,
      concurrency: 5,
      task: async () => {
        inFlight += 1;
        maxSeen = Math.max(maxSeen, inFlight);
        await new Promise((r) => setTimeout(r, 15));
        inFlight -= 1;
        return { result: { ok: true, latencyMs: 15 }, latencyMs: 15 };
      },
    });
    expect(outcomes).toHaveLength(20);
    expect(maxSeen).toBe(5);
    expect(peakInFlight).toBe(5);
  });

  it('runs every request exactly once, even with fewer requests than workers', async () => {
    const ran = [];
    const { outcomes, peakInFlight } = await runPool({
      total: 3,
      concurrency: 10,
      task: async (i) => {
        ran.push(i);
        return { result: { ok: true }, latencyMs: 1 };
      },
    });
    expect(ran.sort()).toEqual([0, 1, 2]);
    expect(outcomes).toHaveLength(3);
    expect(peakInFlight).toBeLessThanOrEqual(3);
  });

  it('turns a throwing task into an error outcome instead of failing the run', async () => {
    const { outcomes } = await runPool({
      total: 2,
      concurrency: 2,
      task: async (i) => {
        if (i === 0) throw new Error('boom');
        return { result: { ok: true }, latencyMs: 1 };
      },
    });
    expect(outcomes[0]).toMatchObject({ ok: false, kind: 'error', detail: 'boom' });
    expect(outcomes[1].ok).toBe(true);
  });
});

describe('summarizeStage', () => {
  it('computes rates, latency of successes only, and throughput', () => {
    const outcomes = [
      { ok: true, latencyMs: 100 },
      { ok: true, latencyMs: 300 },
      { ok: false, kind: 'timeout', detail: 't', latencyMs: 15000 },
      { ok: false, kind: 'overload', detail: 'HTTP 503', latencyMs: 5 },
    ];
    const s = summarizeStage({ concurrency: 4, outcomes, wallMs: 2000, peakInFlight: 4 });
    expect(s).toMatchObject({ requests: 4, ok: 2, errorRate: 0.5, timeoutRate: 0.25, overloadRate: 0.25, otherErrorRate: 0 });
    expect(s.latencyMs).toMatchObject({ n: 2, mean: 200 }); // the 15s timeout is NOT in the latency stats
    expect(s.throughputOkPerSec).toBe(1);
    expect(s.errorSamples).toEqual(['timeout: t', 'overload: HTTP 503']);
  });
});

describe('startProbe', () => {
  it('times samples until stopped and counts failures', async () => {
    let calls = 0;
    const probe = startProbe({
      intervalMs: 5,
      sample: async () => {
        calls += 1;
        if (calls === 2) throw new Error('down');
      },
    });
    await new Promise((r) => setTimeout(r, 60));
    const out = await probe.stop();
    expect(out.n).toBeGreaterThan(2);
    expect(out.failures).toBe(1);
    const before = calls;
    await new Promise((r) => setTimeout(r, 30));
    expect(calls).toBe(before); // really stopped
  });
});

describe('shouldAbort', () => {
  const stage = (over) => ({ concurrency: 10, requests: 50, ok: 40, errorRate: 0.2, otherErrorRate: 0, ...over });
  it('continues on overload (503) alone - that is load shedding, not failure', () => {
    expect(shouldAbort(stage({ errorRate: 0.8, ok: 10, overloadRate: 0.8, otherErrorRate: 0 }))).toBeNull();
  });
  it('stops when Laya is failing outright', () => {
    expect(shouldAbort(stage({ ok: 0, errorRate: 1, otherErrorRate: 1 }))).toMatch(/every request failed/);
    expect(shouldAbort(stage({ otherErrorRate: 0.6, ok: 20 }))).toMatch(/non-overload errors/);
  });
  it('stops to protect the backend', () => {
    expect(shouldAbort(stage({}), { abortBackendP95Ms: 2000, backend: { p95: 2500, n: 20, failures: 0 } })).toMatch(/protect the backend/);
    expect(shouldAbort(stage({}), { backend: { p95: null, n: 0, failures: 4 } })).toMatch(/stopped answering/);
    expect(shouldAbort(stage({}), { backend: { p95: 50, n: 20, failures: 0 } })).toBeNull();
  });
});

describe('scripts/laya-load-test.js (end to end)', () => {
  let laya;
  let backend;
  let tmp;
  let layaInFlight = 0;
  let layaPeak = 0;
  let layaCalls = 0;

  const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));

  beforeAll(async () => {
    laya = http.createServer((req, res) => {
      if (req.url === '/health') return res.end('{"status":"ok"}');
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        layaCalls += 1;
        // Like Laya past LAYA_MAX_CONCURRENT: refuse, don't queue.
        if (layaInFlight >= 3) {
          res.statusCode = 503;
          return res.end('busy');
        }
        layaInFlight += 1;
        layaPeak = Math.max(layaPeak, layaInFlight);
        const q = JSON.parse(body).questions || {};
        const answers = {};
        for (const k of Object.keys(q)) answers[k] = q[k].type === 'noul' ? { type: 'noul', noul: 0.3 } : { type: 'choice', choice: 'dinner', confidence: 0.5 };
        setTimeout(() => {
          layaInFlight -= 1;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ model: 'laya-rl-agent', answers, usage: { input_tokens: 1, output_tokens: 0 } }));
        }, 40);
      });
    });
    backend = http.createServer((req, res) => res.end('ok'));
    const layaPort = await listen(laya);
    const backendPort = await listen(backend);
    tmp = { layaUrl: `http://127.0.0.1:${layaPort}`, probeUrl: `http://127.0.0.1:${backendPort}/health`, dir: fs.mkdtempSync(path.join(os.tmpdir(), 'laya-load-')) };
  });

  afterAll(async () => {
    await new Promise((r) => laya.close(r));
    await new Promise((r) => backend.close(r));
    fs.rmSync(tmp.dir, { recursive: true, force: true });
  });

  const run = (args, env = {}) =>
    new Promise((resolve) => {
      execFile(
        process.execPath,
        [path.join(__dirname, '..', 'scripts', 'laya-load-test.js'), ...args],
        { env: { ...process.env, OPENAI_API_KEY: 'dummy', LAYA_ENABLED: 'true', LAYA_BASE_URL: tmp.layaUrl, LAYA_API_KEY: 'k', ...env }, cwd: path.join(__dirname, '..') },
        (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr })
      );
    });

  it('refuses to run without --yes (it loads the VM)', async () => {
    const before = layaCalls;
    const r = await run([]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/Refusing to run without --yes/);
    expect(layaCalls).toBe(before);
  });

  it('refuses when Laya is not configured', async () => {
    const r = await run(['--yes'], { LAYA_ENABLED: 'false' });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/LAYA_ENABLED=true/);
  });

  it('runs the stages, reports 503s as overload (not errors), and measures the backend', async () => {
    const out = path.join(tmp.dir, 'load.json');
    const r = await run([
      '--yes', '--levels=1,6', '--requests-per-level=24', '--cooldown-ms=0', '--baseline-ms=300',
      `--probe-url=${tmp.probeUrl}`, `--out=${out}`, '--timeout-ms=2000',
    ]);
    expect(r.code).toBe(0);
    const report = JSON.parse(fs.readFileSync(out, 'utf8'));

    expect(report.stages.map((s) => s.concurrency)).toEqual([1, 6]);
    expect(report.backendBaseline.n).toBeGreaterThan(0);

    const [one, six] = report.stages;
    // concurrency 1: nothing to shed, everything succeeds
    expect(one).toMatchObject({ requests: 24, ok: 24, errorRate: 0, overloadRate: 0 });
    // concurrency 6 against a Laya that sheds past 3: some 503s, classified as overload
    expect(six.peakInFlight).toBe(6);
    expect(six.overloadRate).toBeGreaterThan(0);
    expect(six.otherErrorRate).toBe(0);
    expect(six.ok + Math.round(six.overloadRate * 24)).toBe(24);
    expect(layaPeak).toBeLessThanOrEqual(3);
    // latency stats and the backend probe are recorded per stage
    expect(one.latencyMs.p50).toBeGreaterThan(0);
    expect(six.backend.n).toBeGreaterThan(0);
    expect(report.stoppedEarly).toBeNull(); // 503s alone do not abort the run
  });

  it('does not load test a Laya that never answers the warm-up', async () => {
    const r = await run(
      ['--yes', '--levels=2', '--cooldown-ms=0', '--baseline-ms=100', `--probe-url=${tmp.probeUrl}`],
      { LAYA_BASE_URL: 'http://127.0.0.1:1' } // nothing listens here
    );
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/none of the warm-up calls/);
  });

  it('stops escalating when Laya answers the warm-up and then starts failing', async () => {
    let calls = 0;
    const flaky = http.createServer((req, res) => {
      req.on('data', () => {});
      req.on('end', () => {
        if (req.method !== 'POST') return res.end('{"status":"ok"}'); // the script's own /health snapshots
        calls += 1;
        if (calls <= 3) { // the three warm-up calls succeed
          res.setHeader('Content-Type', 'application/json');
          return res.end(JSON.stringify({ model: 'm', answers: { meal_type_fit: { type: 'choice', choice: 'dinner', confidence: 0.5 } }, usage: {} }));
        }
        res.statusCode = 500;
        return res.end('broken');
      });
    });
    const port = await listen(flaky);
    try {
      const out = path.join(tmp.dir, 'flaky.json');
      const r = await run(
        ['--yes', '--levels=2,4', '--requests-per-level=12', '--cooldown-ms=0', '--baseline-ms=100', `--probe-url=${tmp.probeUrl}`, `--out=${out}`],
        { LAYA_BASE_URL: `http://127.0.0.1:${port}` }
      );
      expect(r.code).toBe(0);
      const report = JSON.parse(fs.readFileSync(out, 'utf8'));
      expect(report.warmup).toEqual({ ok: 3, of: 3 });
      expect(report.stoppedEarly).toMatch(/every request failed|non-overload errors/);
      expect(report.stages).toHaveLength(1); // never reached concurrency 4
      expect(report.stages[0].errorSamples[0]).toMatch(/HTTP 500/);
    } finally {
      await new Promise((r2) => flaky.close(r2));
    }
  });
});
