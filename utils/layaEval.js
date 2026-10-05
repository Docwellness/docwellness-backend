/**
 * Pure helpers shared by the Laya evaluation + shadow-report tooling
 * (scripts/laya-eval-run.js, scripts/laya-eval-export-review-sheet.js,
 * scripts/laya-shadow-report.js) and tests/layaEval.test.js. No I/O, no
 * database, no network - so everything here is unit-testable and the scripts
 * stay thin. See tests/laya/README.md and docs/laya-evaluation.md.
 *
 * Nothing here produces evaluation DATA. The dataset is a human deliverable
 * (dietician-reviewed); these helpers only score against it once it exists.
 */

// Recipe.servingTime values -> the meal_type labels Laya's meal_type_fit
// question answers with (see layaDecisionService.classifyRecipe). A null
// means "no clean single meal type" (a drink, or Brunch which is genuinely
// breakfast-or-lunch) - those recipes are NOT scorable for meal type, so
// they're skipped rather than counted as Laya errors.
const MEAL_TYPE_FROM_SERVING_TIME = {
  Breakfast: 'breakfast',
  Lunch: 'lunch',
  Dinner: 'dinner',
  'Evening Snack': 'snack',
  'Morning Drink': null,
  Brunch: null,
  'Night Drink': null,
};

function mealTypeFromServingTime(servingTime) {
  return Object.prototype.hasOwnProperty.call(MEAL_TYPE_FROM_SERVING_TIME, servingTime)
    ? MEAL_TYPE_FROM_SERVING_TIME[servingTime]
    : null;
}

// Laya's yes/no ("noul") answer is a probability of "yes" in [0,1]
// (observed: {"type":"noul","noul":0.28}), not a boolean.
const DEFAULT_NOUL_THRESHOLD = 0.5;

function noulToBoolean(answer, threshold = DEFAULT_NOUL_THRESHOLD) {
  if (!answer || typeof answer.noul !== 'number') return null;
  return answer.noul >= threshold;
}

// What each evaluation category asks Laya, and how to read the answer back.
// `extract` returns { field: value } so a category can score several fields
// (recipe_classification scores meal_type AND protein_level).
const CATEGORIES = {
  recipe_classification: {
    service: 'classifyRecipe',
    args: (input) => ({ recipe: input.recipe }),
    extract: (answers) => ({
      meal_type: answers?.meal_type_fit?.choice ?? null,
      protein_level: answers?.protein_level?.choice ?? null,
    }),
    confidence: (answers) => minConfidence(answers),
  },
  meal_type: {
    service: 'classifyRecipe',
    args: (input) => ({ recipe: input.recipe }),
    extract: (answers) => ({ meal_type: answers?.meal_type_fit?.choice ?? null }),
    confidence: (answers) => answers?.meal_type_fit?.confidence ?? null,
  },
  diet_compatibility: {
    service: 'checkRecipeCompatibility',
    args: (input) => ({ recipe: input.recipe, userProfile: input.userProfile || {} }),
    extract: (answers, opts) => ({ compatible: noulToBoolean(answers?.compatible, opts?.noulThreshold) }),
    confidence: (answers) => noulDistance(answers?.compatible),
  },
  preference_matching: {
    // Same Laya question as diet_compatibility; the dataset differs (the
    // profile's preferences/cravings are what decide the expected answer).
    service: 'checkRecipeCompatibility',
    args: (input) => ({ recipe: input.recipe, userProfile: input.userProfile || {} }),
    extract: (answers, opts) => ({ compatible: noulToBoolean(answers?.compatible, opts?.noulThreshold) }),
    confidence: (answers) => noulDistance(answers?.compatible),
  },
  review_gating: {
    service: 'requiresDieticianReview',
    args: (input) => ({ decisionSummary: input.decisionSummary }),
    extract: (answers, opts) => ({ needs_review: noulToBoolean(answers?.needs_review, opts?.noulThreshold) }),
    confidence: (answers) => noulDistance(answers?.needs_review),
  },
};

function minConfidence(answers) {
  const values = Object.values(answers || {})
    .map((a) => a && a.confidence)
    .filter((c) => typeof c === 'number');
  return values.length ? Math.min(...values) : null;
}

// For a noul probability p, how far from the 0.5 coin-flip it is, scaled 0-1
// (0 = undecided, 1 = certain). Comparable-ish to a choice confidence.
function noulDistance(answer) {
  if (!answer || typeof answer.noul !== 'number') return null;
  return Math.abs(answer.noul - 0.5) * 2;
}

// An example counts toward accuracy only if a dietician signed it off and it
// has an expected answer. Pending/unreviewed rows are reported, never scored.
function isReviewed(example) {
  return Boolean(example) && example.reviewed_by === 'dietician' && example.expected != null;
}

function percentile(sortedAsc, p) {
  if (!sortedAsc.length) return null;
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil((p / 100) * sortedAsc.length) - 1));
  return sortedAsc[idx];
}

function summarizeLatencies(values) {
  const ms = values.filter((v) => typeof v === 'number').sort((a, b) => a - b);
  if (!ms.length) return { n: 0, mean: null, p50: null, p95: null, p99: null };
  const sum = ms.reduce((a, b) => a + b, 0);
  return {
    n: ms.length,
    mean: Math.round(sum / ms.length),
    p50: percentile(ms, 50),
    p95: percentile(ms, 95),
    p99: percentile(ms, 99),
  };
}

/**
 * Score one category's results. `results` is an array of
 * { expected: {field: value}, predicted: {field: value}|null, confidence,
 *   latencyMs, error }. An errored/null prediction counts as an error, not as
 * a wrong answer, and is excluded from accuracy (reported separately).
 */
function scoreResults(results) {
  const perField = {};
  const latencies = [];
  let errors = 0;
  const confRight = [];
  const confWrong = [];

  for (const r of results) {
    if (typeof r.latencyMs === 'number') latencies.push(r.latencyMs);
    if (!r.predicted || r.error) {
      errors += 1;
      continue;
    }
    for (const [field, expectedValue] of Object.entries(r.expected || {})) {
      const predictedValue = r.predicted[field];
      const f = (perField[field] = perField[field] || { n: 0, correct: 0, confusion: {} });
      if (predictedValue == null) continue; // Laya gave no answer for this field
      f.n += 1;
      const ok = predictedValue === expectedValue;
      if (ok) f.correct += 1;
      const key = `${expectedValue} -> ${predictedValue}`;
      f.confusion[key] = (f.confusion[key] || 0) + 1;
      if (typeof r.confidence === 'number') (ok ? confRight : confWrong).push(r.confidence);
    }
  }

  const mean = (a) => (a.length ? Number((a.reduce((x, y) => x + y, 0) / a.length).toFixed(3)) : null);
  const fields = {};
  for (const [field, f] of Object.entries(perField)) {
    fields[field] = { n: f.n, correct: f.correct, accuracy: f.n ? Number((f.correct / f.n).toFixed(3)) : null, confusion: f.confusion };
  }
  return {
    examples: results.length,
    errors,
    fields,
    meanConfidenceWhenRight: mean(confRight),
    meanConfidenceWhenWrong: mean(confWrong),
    latency: summarizeLatencies(latencies),
  };
}

// ---- shadow-row reporting (scripts/laya-shadow-report.js) -----------------

/**
 * Summarize GenerationLog shadow rows for one surface. `excludeDieticianIds`
 * drops test traffic (e.g. the test dietician account used for manual
 * generations) so it can't be mistaken for real usage.
 */
function summarizeShadowRows(rows, { excludeDieticianIds = [], surface = 'recipe_classification' } = {}) {
  const exclude = new Set(excludeDieticianIds.map(String));
  const onSurface = rows.filter((r) => r.layaSurface === surface);
  const kept = onSurface.filter((r) => !exclude.has(String(r.dieticianId)));
  // Shown BEFORE exclusion so a test account can be identified (it will be the
  // one with a burst of rows) and passed to --exclude-dietician.
  const rowsByDieticianId = {};
  for (const r of onSurface) {
    const k = String(r.dieticianId);
    rowsByDieticianId[k] = (rowsByDieticianId[k] || 0) + 1;
  }

  const byReason = {};
  const okRows = [];
  for (const r of kept) {
    if (r.succeeded && r.layaDecisions && r.layaDecisions.answers) okRows.push(r);
    else {
      const reason = (r.layaError && r.layaError.reason) || 'unknown';
      byReason[reason] = (byReason[reason] || 0) + 1;
    }
  }

  // Meal-type agreement against what the dietician requested (surface
  // recipe_classification only), skipping slots with no clean meal type.
  let scorable = 0;
  let agree = 0;
  const confusion = {};
  const protein = {};
  for (const r of okRows) {
    const answers = r.layaDecisions.answers;
    const lp = answers?.protein_level?.choice;
    if (lp) protein[lp] = (protein[lp] || 0) + 1;
    const requested = mealTypeFromServingTime(r.layaDecisions.reference?.servingTime);
    const predicted = answers?.meal_type_fit?.choice;
    if (!requested || !predicted) continue;
    scorable += 1;
    if (requested === predicted) agree += 1;
    const key = `${requested} -> ${predicted}`;
    confusion[key] = (confusion[key] || 0) + 1;
  }

  return {
    surface,
    rowsConsidered: kept.length,
    excludedAsTestTraffic: onSurface.length - kept.length,
    rowsByDieticianId,
    succeeded: okRows.length,
    failedByReason: byReason,
    latency: summarizeLatencies(okRows.map((r) => r.layaLatencyMs)),
    mealTypeAgreement: { scorable, agree, rate: scorable ? Number((agree / scorable).toFixed(3)) : null, confusion },
    laya_protein_level_distribution: protein,
    note:
      'Agreement is Laya vs the slot the dietician REQUESTED - a consistency signal, not accuracy. ' +
      'Accuracy needs the dietician-reviewed dataset (tests/laya/README.md).',
  };
}

// ---- review-sheet sampling (scripts/laya-eval-export-review-sheet.js) -----

// Small deterministic PRNG (mulberry32) so the same --seed always draws the
// same sample - a review sheet must be reproducible.
function seededRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Stratified sample: up to `perClass` items for each distinct classOf(item),
 * chosen deterministically from `seed`. Classes with fewer items than
 * `perClass` contribute everything they have (reported by the caller).
 */
function sampleStratified(items, classOf, perClass, seed) {
  const rand = seededRandom(seed);
  const groups = new Map();
  for (const it of items) {
    const c = classOf(it);
    if (c == null) continue;
    if (!groups.has(c)) groups.set(c, []);
    groups.get(c).push(it);
  }
  const picked = [];
  for (const c of [...groups.keys()].sort()) {
    const arr = groups.get(c).slice();
    // Fisher-Yates with the seeded PRNG
    for (let i = arr.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rand() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    picked.push(...arr.slice(0, perClass));
  }
  return picked;
}

module.exports = {
  MEAL_TYPE_FROM_SERVING_TIME,
  mealTypeFromServingTime,
  DEFAULT_NOUL_THRESHOLD,
  noulToBoolean,
  CATEGORIES,
  isReviewed,
  percentile,
  summarizeLatencies,
  scoreResults,
  summarizeShadowRows,
  seededRandom,
  sampleStratified,
};
