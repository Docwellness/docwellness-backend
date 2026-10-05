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
  noulToBoolean,
  isReviewed,
  percentile,
  summarizeLatencies,
  scoreResults,
  summarizeShadowRows,
  scoreSlots,
  sampleStratified,
  shuffleSeeded,
  CATEGORIES,
} = require('../utils/layaEval');

const { SLOT_KEYS } = require('../utils/layaSlots');

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
  const answers = {
    slot_lunch: { type: 'noul', noul: 0.8 },
    slot_dinner: { type: 'noul', noul: 0.7 },
    protein_level: { type: 'choice', choice: 'low', confidence: 0.2 },
  };
  it('recipe_classification scores protein as a single field and flags the multi-label slots', () => {
    expect(CATEGORIES.recipe_classification.extract(answers)).toEqual({ protein_level: 'low' });
    expect(CATEGORIES.recipe_classification.confidence(answers)).toBe(0.2);
    expect(CATEGORIES.recipe_classification.slots).toBe(true);
    expect(CATEGORIES.meal_type.slots).toBe(true);
    expect(CATEGORIES.meal_type.extract(answers)).toEqual({});
  });
  it('compatibility and review gating read the noul probability', () => {
    expect(CATEGORIES.diet_compatibility.extract({ compatible: { type: 'noul', noul: 0.28 } })).toEqual({ compatible: false });
    expect(CATEGORIES.review_gating.extract({ needs_review: { type: 'noul', noul: 0.8 } })).toEqual({ needs_review: true });
  });
});

describe('scoreSlots (multi-label serving slots)', () => {
  // probs: yes-probability per slot. Only the slots named are non-null.
  const probs = (over) => ({ ...Object.fromEntries(SLOT_KEYS.map((k) => [k, 0.1])), ...over });

  it('computes per-slot precision/recall, micro averages, top pick and exact-set match', () => {
    const r = scoreSlots([
      // Laya says lunch+dinner; the dietician accepts lunch+dinner: perfect
      { expectedSlots: ['lunch', 'dinner'], slotProbs: probs({ lunch: 0.9, dinner: 0.8 }) },
      // Laya says only dinner; the dietician accepts lunch: top pick wrong, lunch missed, dinner a false alarm
      { expectedSlots: ['lunch'], slotProbs: probs({ dinner: 0.9 }) },
    ]);
    expect(r.examples).toBe(2);
    expect(r.slots.lunch).toMatchObject({ tp: 1, fn: 1, fp: 0, support: 2, precision: 1, recall: 0.5 });
    expect(r.slots.dinner).toMatchObject({ tp: 1, fp: 1, fn: 0, precision: 0.5, recall: 1 });
    expect(r.slots.brunch).toMatchObject({ tp: 0, fp: 0, fn: 0, tn: 2, precision: null, recall: null });
    expect(r.micro).toMatchObject({ precision: 0.667, recall: 0.667 });
    expect(r.topPickInExpectedSet).toBe(0.5); // first top pick = lunch (ok), second = dinner (not accepted)
    expect(r.exactSetMatch).toBe(0.5);
    expect(r.meanSlotsPredicted).toBe(1.5);
    expect(r.meanSlotsExpected).toBe(1.5);
    expect(r.baselineAllYesPrecision).toBe(Number((3 / 14).toFixed(3))); // 3 accepted slots out of 14 decisions
  });

  it('respects the threshold and ties go to the earlier slot', () => {
    const r = scoreSlots([{ expectedSlots: ['breakfast'], slotProbs: probs({ breakfast: 0.4, lunch: 0.4 }) }], { threshold: 0.3 });
    expect(r.slots.breakfast.tp).toBe(1);
    expect(r.slots.lunch.fp).toBe(1);
    expect(r.topPickInExpectedSet).toBe(1); // breakfast and lunch tie at 0.4; breakfast comes first
  });

  it('skips errored rows, rows with no slot answers and rows with no expected slots', () => {
    const r = scoreSlots([
      { expectedSlots: ['lunch'], slotProbs: null, error: 'timeout' },
      { expectedSlots: ['lunch'], slotProbs: Object.fromEntries(SLOT_KEYS.map((k) => [k, null])) },
      { expectedSlots: null, slotProbs: probs({ lunch: 0.9 }) },
    ]);
    expect(r.examples).toBe(0);
    expect(r.micro).toEqual({ precision: null, recall: null, f1: null });
  });

  it('shows that answering yes to everything is not rewarded: perfect recall but low precision', () => {
    const allYes = Object.fromEntries(SLOT_KEYS.map((k) => [k, 0.95]));
    const r = scoreSlots([{ expectedSlots: ['lunch'], slotProbs: allYes }]);
    expect(r.micro.recall).toBe(1);
    expect(r.micro.precision).toBe(Number((1 / 7).toFixed(3)));
    expect(r.baselineAllYesPrecision).toBe(r.micro.precision);
  });
});

describe('summarizeShadowRows', () => {
  const slotAnswers = (over) => ({
    ...Object.fromEntries(SLOT_KEYS.map((k) => [`slot_${k}`, { type: 'noul', noul: 0.1 }])),
    protein_level: { choice: 'low' },
    ...over,
  });
  const yes = (k, p = 0.9) => ({ [`slot_${k}`]: { type: 'noul', noul: p } });
  const row = (over) => ({
    layaSurface: 'recipe_classification',
    dieticianId: 'real1',
    succeeded: true,
    layaLatencyMs: 5000,
    layaDecisions: { answers: slotAnswers(yes('dinner')), reference: { servingTime: 'Dinner' } },
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
    expect(s.requestedSlotAgreement.scorable).toBe(1);
  });

  it('reports whether Laya rates the REQUESTED slot suitable, across all seven slots incl. drinks', () => {
    const rows = [
      row({}), // requested Dinner, Laya says dinner: suitable, top pick matches
      row({ layaDecisions: { answers: slotAnswers({ ...yes('lunch', 0.8), ...yes('dinner', 0.6) }), reference: { servingTime: 'Dinner' } } }), // suitable but top is lunch
      row({ layaDecisions: { answers: slotAnswers(yes('breakfast')), reference: { servingTime: 'Morning Drink' } } }), // drink: requested slot not suitable
      row({ layaDecisions: { answers: slotAnswers(yes('night_drink')), reference: { servingTime: 'Night Drink' } } }),
    ];
    const a = summarizeShadowRows(rows).requestedSlotAgreement;
    expect(a).toMatchObject({ scorable: 4, ratedSuitable: 3, rate: 0.75, topPickIsRequested: 2, topPickRate: 0.5 });
    expect(a.meanSlotsRatedSuitable).toBe(1.25); // 1 + 2 + 1 + 1 over 4 recipes
    expect(a.bySlot.dinner).toEqual({ n: 2, ratedSuitable: 2, topIsRequested: 1 });
    expect(a.bySlot.morning_drink).toEqual({ n: 1, ratedSuitable: 0, topIsRequested: 0 });
    expect(a.bySlot.night_drink).toEqual({ n: 1, ratedSuitable: 1, topIsRequested: 1 });
  });

  it('skips older rows that predate the per-slot questions (they have no slot answers)', () => {
    const old = row({ layaDecisions: { answers: { meal_type_fit: { choice: 'dinner' }, protein_level: { choice: 'low' } }, reference: { servingTime: 'Dinner' } } });
    const s = summarizeShadowRows([old]);
    expect(s.succeeded).toBe(1);
    expect(s.requestedSlotAgreement.scorable).toBe(0);
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
        // Always says yes to dinner only (0.9) and "low" protein, so the fixture has known
        // hits and misses.
        const answers = { protein_level: { type: 'choice', choice: 'low', confidence: 0.3 } };
        for (const q of Object.keys(JSON.parse(body).questions)) {
          if (q.startsWith('slot_')) answers[q] = { type: 'noul', noul: q === 'slot_dinner' ? 0.9 : 0.1 };
        }
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ model: 'laya-rl-agent', answers, usage: { input_tokens: 1, output_tokens: 0 } }));
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    baseUrl = `http://127.0.0.1:${server.address().port}`;

    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'laya-eval-'));
    // A deliberately carries a servingTime (an old-style row): the service must still not send it.
    const recipe = (name, extra = {}) => ({ recipe: { name, ingredients: [{ name: 'x' }], ...extra } });
    fs.writeFileSync(path.join(dir, 'recipe_classification.json'), JSON.stringify([
      { input: recipe('A', { servingTime: 'Dinner' }), expected: { suitable_slots: ['lunch', 'dinner'], protein_level: 'low' }, reviewed_by: 'dietician' },
      { input: recipe('B'), expected: { suitable_slots: ['lunch'], protein_level: 'low' }, reviewed_by: 'dietician' },
      // Never scored: not reviewed, and a pending sheet row.
      { input: recipe('C'), expected: { suitable_slots: ['dinner'] }, reviewed_by: null },
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
    expect(cat.fields.protein_level).toMatchObject({ n: 2, correct: 2, accuracy: 1 });
    // multi-label slots: Laya says yes to dinner only. A accepts lunch+dinner, B accepts lunch.
    expect(cat.slots.examples).toBe(2);
    expect(cat.slots.slots.dinner).toMatchObject({ tp: 1, fp: 1, fn: 0, precision: 0.5, recall: 1 });
    expect(cat.slots.slots.lunch).toMatchObject({ tp: 0, fn: 2, recall: 0 });
    expect(cat.slots.micro).toMatchObject({ precision: 0.5, recall: 0.333 });
    expect(cat.slots.topPickInExpectedSet).toBe(0.5);
    expect(r.stdout).toMatch(/serving slots \(yes at >= 0\.5\)/);
    // what Laya was shown: seven slot questions plus protein, and never the servingTime
    expect(Object.keys(seen[0].body.questions)).toHaveLength(8);
    expect(JSON.stringify(seen.map((x) => x.body))).not.toMatch(/servingTime|"Dinner"/);
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
