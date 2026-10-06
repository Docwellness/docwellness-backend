/**
 * Category review: turns "Laya's top pick differs from the stored category" into
 * a question a dietician can answer, so agreement with a label becomes accuracy.
 *
 * For each recipe where Laya's top category differs from the stored one, the
 * reviewer sees the recipe and TWO options, A and B, in random order (one is the
 * stored category, one is Laya's). They are not told which is which, so neither
 * the dietician's own earlier choice nor the model anchors the answer. The
 * reviewer picks A, B, both, neither (and can name the right category) or
 * unsure. The key (which option was which) is a separate file, joined by id.
 *
 * Pure helpers, no I/O.
 */
const { toCsv, parseCsvObjects } = require('./layaCsv');

const SHEET_COLUMNS = ['id', 'recipe_name', 'ingredients', 'option_a', 'option_b', 'better_option', 'correct_category', 'reviewed_by', 'review_notes'];
const KEY_COLUMNS = ['id', 'recipe_name', 'stored_category', 'laya_category', 'laya_probability', 'option_a_is'];
const ANSWERS = ['a', 'b', 'both', 'neither', 'unsure'];

/** Deterministic coin flip per recipe and seed, so a re-export keeps the same A/B order. */
function flip(id, seed) {
  let h = 2166136261 ^ Number(seed || 0);
  for (const ch of String(id)) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return (h & 1) === 1;
}

/** Highest-probability class key (ties: first listed), or null if no probabilities. */
function topKey(probs, classes) {
  let best = null;
  let bestP = -Infinity;
  for (const c of classes) {
    const p = probs && probs[c.key];
    if (typeof p === 'number' && p > bestP) {
      best = c.key;
      bestP = p;
    }
  }
  return best;
}

/**
 * @param {Array<{id, name, ingredients: [{name}], category, probs}>} items  probs null if the call failed
 * @param {Array<{name, key}>} classes
 * @returns {{ sheet: object[], key: object[], agreed: number, failed: number }}
 */
function buildReview({ items, classes, seed = 1 }) {
  const byKey = new Map(classes.map((c) => [c.key, c.name]));
  const nameToKey = new Map(classes.map((c) => [c.name, c.key]));
  const sheet = [];
  const key = [];
  let agreed = 0;
  let failed = 0;
  for (const it of items) {
    const top = topKey(it.probs, classes);
    if (!top) {
      failed += 1;
      continue;
    }
    if (nameToKey.get(it.category) === top) {
      agreed += 1;
      continue;
    }
    const layaName = byKey.get(top);
    const storedFirst = flip(it.id, seed);
    sheet.push({
      id: it.id,
      recipe_name: it.name,
      ingredients: (it.ingredients || []).map((i) => i.name).join(', '),
      option_a: storedFirst ? it.category : layaName,
      option_b: storedFirst ? layaName : it.category,
      better_option: '',
      correct_category: '',
      reviewed_by: '',
      review_notes: '',
    });
    key.push({
      id: it.id,
      recipe_name: it.name,
      stored_category: it.category,
      laya_category: layaName,
      laya_probability: Number(it.probs[top].toFixed(3)),
      option_a_is: storedFirst ? 'stored' : 'laya',
    });
  }
  return { sheet, key, agreed, failed };
}

const sheetCsv = (rows) => toCsv(rows, SHEET_COLUMNS);
const keyCsv = (rows) => toCsv(rows, KEY_COLUMNS);

/** 95% Wilson interval for k of n, as [low, high]; null if n is 0. */
function wilson(k, n) {
  if (!n) return null;
  const z = 1.96;
  const p = k / n;
  const d = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / d;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Number((centre - half).toFixed(3)), Number((centre + half).toFixed(3))];
}

/**
 * Join a filled sheet to its key and count who was right.
 * A row counts only if it has a reviewer name and a valid better_option; a row
 * with an invalid value is reported as a problem (nothing is silently dropped).
 */
function scoreReview(sheetText, keyText) {
  const sheet = parseCsvObjects(sheetText);
  const keyById = new Map(parseCsvObjects(keyText).map((k) => [k.id, k]));
  const out = { reviewed: 0, pending: 0, stored: 0, laya: 0, both: 0, neither: 0, unsure: 0, byStored: {}, corrections: [], problems: [] };
  for (const row of sheet) {
    const answer = String(row.better_option || '').trim().toLowerCase();
    const reviewer = String(row.reviewed_by || '').trim();
    if (!answer && !reviewer) {
      out.pending += 1;
      continue;
    }
    const k = keyById.get(row.id);
    if (!k) {
      out.problems.push(`id ${row.id}: not in the key file`);
      continue;
    }
    if (!reviewer) {
      out.problems.push(`id ${row.id}: better_option filled but no reviewed_by`);
      continue;
    }
    if (!ANSWERS.includes(answer)) {
      out.problems.push(`id ${row.id}: better_option "${row.better_option}" is not one of ${ANSWERS.join(', ')}`);
      continue;
    }
    out.reviewed += 1;
    let verdict;
    if (answer === 'a' || answer === 'b') verdict = (answer === 'a') === (k.option_a_is === 'stored') ? 'stored' : 'laya';
    else verdict = answer;
    out[verdict] += 1;
    const bucket = (out.byStored[k.stored_category] = out.byStored[k.stored_category] || { stored: 0, laya: 0, both: 0, neither: 0, unsure: 0 });
    bucket[verdict] += 1;
    if (verdict === 'neither' && String(row.correct_category || '').trim()) out.corrections.push({ id: row.id, correct: row.correct_category.trim() });
  }
  const decided = out.stored + out.laya;
  out.layaShareOfDecided = decided ? Number((out.laya / decided).toFixed(3)) : null;
  out.layaShareInterval = wilson(out.laya, decided);
  out.layaAcceptable = out.laya + out.both; // Laya's pick is right or equally fine
  out.storedAcceptable = out.stored + out.both;
  return out;
}

module.exports = { SHEET_COLUMNS, KEY_COLUMNS, ANSWERS, flip, topKey, buildReview, sheetCsv, keyCsv, wilson, scoreReview };
