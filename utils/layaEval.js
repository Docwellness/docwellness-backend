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

const { SLOT_KEYS, slotKeyFromServingTime, slotProbabilities, slotAnswerMode, topSlot } = require('./layaSlots');
const { rankMetrics, rankOf, chanceTopK } = require('./layaRank');

// Laya's yes/no ("noul") answer is a probability of "yes" in [0,1]
// (observed: {"type":"noul","noul":0.28}), not a boolean.
const DEFAULT_NOUL_THRESHOLD = 0.5;

function noulToBoolean(answer, threshold = DEFAULT_NOUL_THRESHOLD) {
  if (!answer || typeof answer.noul !== 'number') return null;
  return answer.noul >= threshold;
}

// What each evaluation category asks Laya, and how to read the answer back.
// `extract` returns { field: value } for single-valued fields (protein_level).
// `slots: true` marks the multi-label question: the dataset lists every serving
// slot a recipe suits (expected.suitable_slots) and scoreSlots() scores Laya's
// seven per-slot yes/no answers against it.
const CATEGORIES = {
  recipe_classification: {
    service: 'classifyRecipe',
    args: (input) => ({ recipe: input.recipe }),
    extract: (answers) => ({ protein_level: answers?.protein_level?.choice ?? null }),
    slots: true,
    confidence: (answers) => answers?.protein_level?.confidence ?? null,
  },
  meal_type: {
    // Same Laya call; scores the serving-slot answers only.
    service: 'classifyRecipe',
    args: (input) => ({ recipe: input.recipe }),
    extract: () => ({}),
    slots: true,
    confidence: () => null,
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

/**
 * Score the multi-label serving-slot answers. Each result needs
 * { expectedSlots: [slot keys the dietician says it suits], slotProbs: { key: p of "yes" } }.
 * A slot counts as predicted when p >= threshold. Errors and rows with no slot
 * answers are skipped (reported by the caller as errors, not as wrong answers).
 * Per slot: precision/recall/F1 with support; overall: micro-averaged
 * precision/recall/F1, how often Laya's single highest-probability slot is one
 * the dietician accepts, and how often the predicted set matches exactly.
 * `baselineAllYesPrecision` is what answering "yes" to every slot would score
 * (recall 1.0), so a precision near it means Laya is not discriminating.
 */
function scoreSlots(results, { threshold = DEFAULT_NOUL_THRESHOLD, mode = null } = {}) {
  const per = Object.fromEntries(SLOT_KEYS.map((k) => [k, { tp: 0, fp: 0, fn: 0, tn: 0 }]));
  let n = 0;
  let topHit = 0;
  let topN = 0;
  let exact = 0;
  let predictedTotal = 0;
  let expectedTotal = 0;
  let decisions = 0;

  for (const r of results) {
    if (r.error || !r.slotProbs || !Array.isArray(r.expectedSlots)) continue;
    const answered = SLOT_KEYS.filter((k) => typeof r.slotProbs[k] === 'number');
    if (!answered.length) continue;
    n += 1;
    const expected = new Set(r.expectedSlots);
    const predicted = new Set(answered.filter((k) => r.slotProbs[k] >= threshold));
    for (const k of answered) {
      const p = predicted.has(k);
      const e = expected.has(k);
      if (p && e) per[k].tp += 1;
      else if (p) per[k].fp += 1;
      else if (e) per[k].fn += 1;
      else per[k].tn += 1;
    }
    decisions += answered.length;
    predictedTotal += predicted.size;
    expectedTotal += expected.size;
    const top = topSlot(r.slotProbs);
    if (top) {
      topN += 1;
      if (expected.has(top)) topHit += 1;
    }
    if (predicted.size === expected.size && [...predicted].every((k) => expected.has(k))) exact += 1;
  }

  const ratio = (a, b) => (b ? Number((a / b).toFixed(3)) : null);
  const f1 = (p, r) => (p != null && r != null && p + r > 0 ? Number(((2 * p * r) / (p + r)).toFixed(3)) : null);
  const slots = {};
  let TP = 0;
  let FP = 0;
  let FN = 0;
  for (const k of SLOT_KEYS) {
    const c = per[k];
    TP += c.tp;
    FP += c.fp;
    FN += c.fn;
    const precision = ratio(c.tp, c.tp + c.fp);
    const recall = ratio(c.tp, c.tp + c.fn);
    slots[k] = { ...c, support: c.tp + c.fn, precision, recall, f1: f1(precision, recall) };
  }
  const precision = ratio(TP, TP + FP);
  const recall = ratio(TP, TP + FN);
  // Threshold-free view of the same scores (utils/layaRank.js). For the one-question
  // 'choice' form the probabilities sum to 1, so the thresholded numbers above are
  // not meaningful and this ranking is the result to read.
  const ranking = rankMetrics(
    results
      .filter((r) => !r.error && r.slotProbs && Array.isArray(r.expectedSlots))
      .map((r) => ({ accepted: r.expectedSlots, probs: r.slotProbs }))
  );
  return {
    examples: n,
    mode,
    threshold,
    ranking,
    slots,
    micro: { precision, recall, f1: f1(precision, recall) },
    topPickInExpectedSet: ratio(topHit, topN),
    exactSetMatch: ratio(exact, n),
    meanSlotsPredicted: n ? Number((predictedTotal / n).toFixed(2)) : null,
    meanSlotsExpected: n ? Number((expectedTotal / n).toFixed(2)) : null,
    baselineAllYesPrecision: ratio(expectedTotal, decisions),
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

  // Does Laya rate the REQUESTED slot suitable? (a recipe can suit several
  // slots, so this is recall of one known-good slot, not accuracy). Rows written
  // before the per-slot questions have no slot answers and are skipped.
  let scorable = 0;
  let topIsRequested = 0;
  let top2IsRequested = 0;
  let rankSum = 0;
  let noulScorable = 0;
  let ratedSuitable = 0;
  let slotsRatedTotal = 0;
  const bySlot = {};
  const protein = {};
  for (const r of okRows) {
    const answers = r.layaDecisions.answers;
    const lp = answers?.protein_level?.choice;
    if (lp) protein[lp] = (protein[lp] || 0) + 1;
    const requested = slotKeyFromServingTime(r.layaDecisions.reference?.servingTime);
    const probs = slotProbabilities(answers);
    const top = topSlot(probs);
    if (!requested || !top) continue;
    scorable += 1;
    const rank = rankOf(probs, requested);
    rankSum += rank;
    if (rank <= 1) topIsRequested += 1;
    if (rank <= 2) top2IsRequested += 1;
    const b2 = (bySlot[requested] = bySlot[requested] || { n: 0, ratedSuitable: 0, topIsRequested: 0 });
    b2.n += 1;
    if (rank <= 1) b2.topIsRequested += 1;
    // The 0.5 "suitable" line only means something for independent yes/no answers.
    if (slotAnswerMode(answers) === 'noul') {
      noulScorable += 1;
      const yes = typeof probs[requested] === 'number' && probs[requested] >= DEFAULT_NOUL_THRESHOLD;
      if (yes) {
        ratedSuitable += 1;
        b2.ratedSuitable += 1;
      }
      slotsRatedTotal += SLOT_KEYS.filter((k) => typeof probs[k] === 'number' && probs[k] >= DEFAULT_NOUL_THRESHOLD).length;
    }
  }

  return {
    surface,
    rowsConsidered: kept.length,
    excludedAsTestTraffic: onSurface.length - kept.length,
    rowsByDieticianId,
    succeeded: okRows.length,
    failedByReason: byReason,
    latency: summarizeLatencies(okRows.map((r) => r.layaLatencyMs)),
    requestedSlotAgreement: {
      scorable,
      // rank-based (works for both answer forms): where the REQUESTED slot lands among the seven
      topPickIsRequested: topIsRequested,
      topPickRate: scorable ? Number((topIsRequested / scorable).toFixed(3)) : null,
      top2IsRequested,
      top2Rate: scorable ? Number((top2IsRequested / scorable).toFixed(3)) : null,
      chanceTop1: Number(chanceTopK(1, 1).toFixed(3)),
      chanceTop2: Number(chanceTopK(1, 2).toFixed(3)),
      meanRankOfRequested: scorable ? Number((rankSum / scorable).toFixed(2)) : null, // chance: 4.0
      // yes/no (noul) rows only: does Laya say yes to the requested slot?
      noulScorable,
      ratedSuitable,
      rate: noulScorable ? Number((ratedSuitable / noulScorable).toFixed(3)) : null,
      meanSlotsRatedSuitable: noulScorable ? Number((slotsRatedTotal / noulScorable).toFixed(2)) : null,
      bySlot,
    },
    laya_protein_level_distribution: protein,
    note:
      'Agreement = does Laya rate the slot the dietician REQUESTED as suitable (a recipe can suit several slots, ' +
      'so this is recall of one known-good slot). Meaningful only for rows written after servingTime was removed ' +
      "from Laya's input AND the per-slot questions were deployed - use --since=<deploy time>. " +
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

/**
 * Deterministic shuffle (same seed -> same order). The stratified sample comes
 * out grouped by class (all breakfast, then all lunch...), and for a BLIND review
 * the row order must not reveal the class.
 */
function shuffleSeeded(items, seed) {
  const rand = seededRandom(seed);
  const arr = items.slice();
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

module.exports = {
  DEFAULT_NOUL_THRESHOLD,
  noulToBoolean,
  CATEGORIES,
  isReviewed,
  percentile,
  summarizeLatencies,
  scoreResults,
  scoreSlots,
  summarizeShadowRows,
  seededRandom,
  sampleStratified,
  shuffleSeeded,
};
