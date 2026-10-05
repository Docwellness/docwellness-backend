/**
 * Tests for the Laya evaluation tooling (utils/layaEval.js and
 * scripts/laya-eval-run.js). No real dataset is used or implied: every example
 * below is a tiny inline fixture exercising the scoring logic, not evaluation
 * data (see tests/laya/README.md - the real dataset is a human deliverable).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFile } = require('child_process');

const {
  mealTypeFromServingTime,
  noulToBoolean,
  isReviewed,
  percentile,
  summarizeLatencies,
  scoreResults,
  summarizeShadowRows,
  sampleStratified,
  shuffleSeeded,
  CATEGORIES,
} = require('../utils/layaEval');

describe('mealTypeFromServingTime', () => {
  it('maps the four clean slots', () => {
    expect(mealTypeFromServingTime('Breakfast')).toBe('breakfast');
    expect(mealTypeFromServingTime('Lunch')).toBe('lunch');
    expect(mealTypeFromServingTime('Dinner')).toBe('dinner');
    expect(mealTypeFromServingTime('Evening Snack')).toBe('snack');
  });
  it('returns null for slots with no single meal type, and for unknown values', () => {
    for (const s of ['Brunch', 'Morning Drink', 'Night Drink', 'Nonsense', undefined]) {
      expect(mealTypeFromServingTime(s)).toBeNull();
    }
  });
});

describe('noulToBoolean (Laya noul answers are probabilities)', () => {
  it('thresholds the observed {type, noul} shape', () => {
    expect(noulToBoolean({ type: 'noul', noul: 0.28 })).toBe(false);
    expect(noulToBoolean({ type: 'noul', noul: 0.5 })).toBe(true);
    expect(noulToBoolean({ type: 'noul', noul: 0.9 })).toBe(true);
    expect(noulToBoolean({ type: 'noul', noul: 0.4 }, 0.3)).toBe(true);
  });
  it('returns null (not false) when there is no usable answer', () => {
    expect(noulToBoolean(undefined)).toBeNull();
    expect(noulToBoolean({ type: 'noul' })).toBeNull();
  });
});

describe('isReviewed', () => {
  it('counts only dietician-reviewed rows that have an expected answer', () => {
    expect(isReviewed({ expected: { meal_type: 'lunch' }, reviewed_by: 'dietician' })).toBe(true);
    expect(isReviewed({ expected: null, reviewed_by: 'dietician' })).toBe(false);
    expect(isReviewed({ expected: { meal_type: 'lunch' }, reviewed_by: null })).toBe(false);
    expect(isReviewed({ expected: { meal_type: 'lunch' }, reviewed_by: 'claude' })).toBe(false);
    expect(isReviewed(null)).toBe(false);
  });
});

describe('latency stats', () => {
  it('computes nearest-rank percentiles', () => {
    const v = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    expect(percentile(v, 50)).toBe(50);
    expect(percentile(v, 95)).toBe(100);
    expect(percentile([], 50)).toBeNull();
  });
  it('ignores non-numbers', () => {
    expect(summarizeLatencies([100, null, 300, undefined])).toMatchObject({ n: 2, mean: 200 });
    expect(summarizeLatencies([])).toEqual({ n: 0, mean: null, p50: null, p95: null, p99: null });
  });
});

describe('scoreResults', () => {
  it('scores each field separately, builds a confusion map, and splits confidence right vs wrong', () => {
    const r = scoreResults([
      { expected: { meal_type: 'dinner', protein_level: 'high' }, predicted: { meal_type: 'dinner', protein_level: 'low' }, confidence: 0.6, latencyMs: 100 },
      { expected: { meal_type: 'lunch', protein_level: 'low' }, predicted: { meal_type: 'dinner', protein_level: 'low' }, confidence: 0.2, latencyMs: 300 },
    ]);
    expect(r.fields.meal_type).toMatchObject({ n: 2, correct: 1, accuracy: 0.5 });
    expect(r.fields.protein_level).toMatchObject({ n: 2, correct: 1, accuracy: 0.5 });
    expect(r.fields.meal_type.confusion).toEqual({ 'dinner -> dinner': 1, 'lunch -> dinner': 1 });
    expect(r.meanConfidenceWhenRight).toBeCloseTo(0.4, 2); // right on meal_type (0.6) and protein (0.2)
    expect(r.latency.mean).toBe(200);
  });

  it('counts errors/timeouts as errors, NOT as wrong answers', () => {
    const r = scoreResults([
      { expected: { meal_type: 'lunch' }, predicted: { meal_type: 'lunch' }, confidence: 0.5, latencyMs: 10 },
      { expected: { meal_type: 'lunch' }, predicted: null, error: 'timeout: No response within 3000ms' },
    ]);
    expect(r.errors).toBe(1);
    expect(r.fields.meal_type).toMatchObject({ n: 1, correct: 1, accuracy: 1 });
  });

  it('skips a field Laya gave no answer for', () => {
    const r = scoreResults([{ expected: { meal_type: 'lunch' }, predicted: { meal_type: null }, confidence: null }]);
    expect(r.fields.meal_type).toMatchObject({ n: 0, correct: 0, accuracy: null });
  });
});

describe('CATEGORIES extract the real Laya answer shapes', () => {
  const choiceAnswers = {
    meal_type_fit: { type: 'choice', choice: 'breakfast', confidence: 0.35 },
    protein_level: { type: 'choice', choice: 'low', confidence: 0.2 },
  };
  it('recipe_classification reads both choice fields and the lowest confidence', () => {
    expect(CATEGORIES.recipe_classification.extract(choiceAnswers)).toEqual({ meal_type: 'breakfast', protein_level: 'low' });
    expect(CATEGORIES.recipe_classification.confidence(choiceAnswers)).toBe(0.2);
  });
  it('compatibility and review gating read the noul probability', () => {
    expect(CATEGORIES.diet_compatibility.extract({ compatible: { type: 'noul', noul: 0.28 } })).toEqual({ compatible: false });
    expect(CATEGORIES.review_gating.extract({ needs_review: { type: 'noul', noul: 0.8 } })).toEqual({ needs_review: true });
  });
});

describe('summarizeShadowRows', () => {
  const row = (over) => ({
    layaSurface: 'recipe_classification',
    dieticianId: 'real1',
    succeeded: true,
    layaLatencyMs: 5000,
    layaDecisions: { answers: { meal_type_fit: { choice: 'dinner' }, protein_level: { choice: 'low' } }, reference: { servingTime: 'Dinner' } },
    ...over,
  });

  it('excludes test-account rows and says how many it dropped', () => {
    const rows = [row({}), row({ dieticianId: 'test1' }), row({ dieticianId: 'test1' })];
    const s = summarizeShadowRows(rows, { excludeDieticianIds: ['test1'] });
    expect(s.rowsConsidered).toBe(1);
    expect(s.excludedAsTestTraffic).toBe(2);
    // Counts are shown before exclusion so the test account can be identified.
    expect(s.rowsByDieticianId).toEqual({ real1: 1, test1: 2 });
  });

  it('breaks failures down by reason and keeps them out of agreement', () => {
    const rows = [
      row({}),
      row({ succeeded: false, layaDecisions: { reference: { servingTime: 'Lunch' } }, layaError: { reason: 'timeout' } }),
      row({ succeeded: false, layaDecisions: { reference: { servingTime: 'Lunch' } }, layaError: { reason: 'error', detail: 'x' } }),
    ];
    const s = summarizeShadowRows(rows);
    expect(s.succeeded).toBe(1);
    expect(s.failedByReason).toEqual({ timeout: 1, error: 1 });
    expect(s.mealTypeAgreement.scorable).toBe(1);
  });

  it('computes agreement and skips slots with no clean meal type', () => {
    const rows = [
      row({}),
      row({ layaDecisions: { answers: { meal_type_fit: { choice: 'dinner' } }, reference: { servingTime: 'Evening Snack' } } }),
      row({ layaDecisions: { answers: { meal_type_fit: { choice: 'lunch' } }, reference: { servingTime: 'Morning Drink' } } }),
    ];
    const a = summarizeShadowRows(rows).mealTypeAgreement;
    expect(a).toMatchObject({ scorable: 2, agree: 1, rate: 0.5 });
    expect(a.confusion).toEqual({ 'dinner -> dinner': 1, 'snack -> dinner': 1 });
  });

  it('ignores rows from other surfaces', () => {
    expect(summarizeShadowRows([row({ layaSurface: 'diet_plan_review' })]).rowsConsidered).toBe(0);
  });
});

describe('sampleStratified', () => {
  const items = [
    ...Array.from({ length: 10 }, (_, i) => ({ id: `b${i}`, c: 'breakfast' })),
    ...Array.from({ length: 10 }, (_, i) => ({ id: `l${i}`, c: 'lunch' })),
    ...Array.from({ length: 2 }, (_, i) => ({ id: `s${i}`, c: 'snack' })),
    { id: 'x', c: null },
  ];
  it('caps each class, keeps small classes whole, and skips null classes', () => {
    const out = sampleStratified(items, (i) => i.c, 4, 1);
    const count = (c) => out.filter((i) => i.c === c).length;
    expect(count('breakfast')).toBe(4);
    expect(count('lunch')).toBe(4);
    expect(count('snack')).toBe(2);
    expect(out.find((i) => i.id === 'x')).toBeUndefined();
  });
  it('is deterministic for a seed and differs across seeds', () => {
    const a = sampleStratified(items, (i) => i.c, 4, 7).map((i) => i.id);
    const b = sampleStratified(items, (i) => i.c, 4, 7).map((i) => i.id);
    const c = sampleStratified(items, (i) => i.c, 4, 8).map((i) => i.id);
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });
});

describe('shuffleSeeded (blind review: row order must not reveal the class)', () => {
  const grouped = [
    ...Array.from({ length: 10 }, (_, i) => ({ id: `b${i}`, c: 'breakfast' })),
    ...Array.from({ length: 10 }, (_, i) => ({ id: `l${i}`, c: 'lunch' })),
  ];
  it('is deterministic per seed, keeps every item exactly once, and does not mutate the input', () => {
    const copy = grouped.slice();
    const a = shuffleSeeded(grouped, 3);
    expect(shuffleSeeded(grouped, 3)).toEqual(a);
    expect(shuffleSeeded(grouped, 4)).not.toEqual(a);
    expect(a.map((x) => x.id).sort()).toEqual(grouped.map((x) => x.id).sort());
    expect(grouped).toEqual(copy);
  });
  it('breaks up the class blocks', () => {
    const a = shuffleSeeded(grouped, 3).map((x) => x.c);
    const firstTen = a.slice(0, 10).filter((c) => c === 'breakfast').length;
    expect(firstTen).toBeGreaterThan(0);
    expect(firstTen).toBeLessThan(10); // not "all breakfast first"
  });
});

describe('scripts/laya-eval-run.js (end to end against a fake Laya)', () => {
  let server;
  let baseUrl;
  let dir;
  const seen = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        seen.push({ auth: req.headers.authorization, body: JSON.parse(body) });
        // Always answers "dinner" / "low" so the fixture has one right and one wrong meal_type.
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          model: 'laya-rl-agent',
          answers: {
            meal_type_fit: { type: 'choice', choice: 'dinner', confidence: 0.6 },
            protein_level: { type: 'choice', choice: 'low', confidence: 0.3 },
          },
          usage: { input_tokens: 1, output_tokens: 0 },
        }));
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    baseUrl = `http://127.0.0.1:${server.address().port}`;

    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'laya-eval-'));
    const recipe = (name) => ({ recipe: { name, servingTime: 'Dinner', ingredients: [{ name: 'x' }] } });
    fs.writeFileSync(path.join(dir, 'recipe_classification.json'), JSON.stringify([
      { input: recipe('A'), expected: { meal_type: 'dinner', protein_level: 'low' }, reviewed_by: 'dietician' },
      { input: recipe('B'), expected: { meal_type: 'lunch', protein_level: 'low' }, reviewed_by: 'dietician' },
      // Never scored: not reviewed, and a pending sheet row.
      { input: recipe('C'), expected: { meal_type: 'dinner' }, reviewed_by: null },
      { input: recipe('D'), expected: null, reviewed_by: null },
    ]));
  });

  afterAll(async () => {
    await new Promise((r) => server.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const run = (args, env = {}) =>
    new Promise((resolve) => {
      execFile(
        process.execPath,
        [path.join(__dirname, '..', 'scripts', 'laya-eval-run.js'), ...args],
        { env: { ...process.env, OPENAI_API_KEY: 'dummy', LAYA_ENABLED: 'true', LAYA_BASE_URL: baseUrl, LAYA_API_KEY: 'k', ...env }, cwd: path.join(__dirname, '..') },
        (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr })
      );
    });

  it('scores only reviewed rows, sequentially, and writes a report', async () => {
    const out = path.join(dir, 'out.json');
    const r = await run([`--dir=${dir}`, '--category=recipe_classification', `--out=${out}`]);
    expect(r.code).toBe(0);
    const report = JSON.parse(fs.readFileSync(out, 'utf8'));
    const cat = report.categories.recipe_classification;
    expect(cat).toMatchObject({ status: 'scored', reviewedScored: 2, unreviewedSkipped: 2, errors: 0 });
    expect(cat.fields.meal_type).toMatchObject({ n: 2, correct: 1, accuracy: 0.5 });
    expect(cat.fields.protein_level).toMatchObject({ n: 2, correct: 2, accuracy: 1 });
    expect(report.servedModels).toEqual(['laya-rl-agent']);
    expect(seen).toHaveLength(2); // the two unreviewed rows never reached Laya
    expect(seen.every((s) => s.auth === 'Bearer k')).toBe(true);
  });

  it('skips categories with no dataset file instead of inventing one', async () => {
    const out = path.join(dir, 'out2.json');
    const r = await run([`--dir=${dir}`, '--category=review_gating', `--out=${out}`]);
    expect(r.code).toBe(0);
    expect(JSON.parse(fs.readFileSync(out, 'utf8')).categories.review_gating.status).toBe('no dataset file');
  });

  it('refuses to run when Laya is not enabled', async () => {
    const r = await run([`--dir=${dir}`], { LAYA_ENABLED: 'false' });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/LAYA_ENABLED is not true/);
  });
});
