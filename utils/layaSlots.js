/**
 * The seven serving slots (Recipe.servingTime) and the per-slot yes/no
 * questions Laya answers about a recipe.
 *
 * A recipe can suit several slots (poha: Breakfast and Brunch; dal: Lunch and
 * Dinner), and drinks and meals are different kinds of thing, so Laya is not
 * asked "which ONE meal is this?" (measured 2026-10-05: lunch-biased, lunch vs
 * dinner a coin flip). It is asked, for each slot, "is this suitable for it?"
 * (multi-label classification), and the dietician-reviewed dataset lists every
 * slot a recipe suits.
 *
 * The descriptions below are part of the prompt Laya sees: changing them
 * changes its answers, so re-measure after any edit. They are drafts for the
 * team to refine.
 */

const SLOTS = [
  { key: 'morning_drink', name: 'Morning Drink', description: 'A drink taken early in the morning, before or instead of breakfast (for example warm lemon water, an herbal infusion, a detox drink).' },
  { key: 'breakfast', name: 'Breakfast', description: 'A morning meal eaten at the start of the day.' },
  { key: 'brunch', name: 'Brunch', description: 'A late-morning meal eaten between breakfast and lunch.' },
  { key: 'lunch', name: 'Lunch', description: 'A substantial midday meal.' },
  { key: 'evening_snack', name: 'Evening Snack', description: 'A light snack or drink eaten in the afternoon or evening, between lunch and dinner.' },
  { key: 'dinner', name: 'Dinner', description: 'A substantial evening meal.' },
  { key: 'night_drink', name: 'Night Drink', description: 'A drink taken at night, before bed (for example warm milk, a calming herbal tea).' },
];

const SLOT_KEYS = SLOTS.map((s) => s.key);
const SLOT_NAMES = SLOTS.map((s) => s.name);

// Accepted spellings when a reviewer types slot names into a spreadsheet.
const ALIASES = {
  'evening snack': 'evening_snack',
  snack: 'evening_snack',
  evening: 'evening_snack',
  'morning drink': 'morning_drink',
  'night drink': 'night_drink',
};
const LOOKUP = new Map();
for (const s of SLOTS) {
  LOOKUP.set(s.key, s.key);
  LOOKUP.set(s.name.toLowerCase(), s.key);
}
for (const [alias, key] of Object.entries(ALIASES)) LOOKUP.set(alias, key);

/** A slot key from a name, key or accepted alias ("Evening Snack", "snack"), else null. */
function slotKey(text) {
  return LOOKUP.get(String(text == null ? '' : text).trim().toLowerCase().replace(/\s+/g, ' ')) || null;
}

/** Recipe.servingTime -> slot key (null for anything that is not one of the seven). */
function slotKeyFromServingTime(servingTime) {
  return SLOTS.find((s) => s.name === servingTime)?.key || null;
}

function slotName(key) {
  return SLOTS.find((s) => s.key === key)?.name || null;
}

/**
 * "Lunch; Dinner" (also commas, slashes, pipes) -> { keys, unknown }.
 * `keys` is de-duplicated and in canonical slot order; `unknown` holds the
 * entries that are not a slot, so the importer can refuse them by name.
 */
function parseSlotList(text) {
  const parts = String(text == null ? '' : text).split(/[;,/|]/).map((p) => p.trim()).filter(Boolean);
  const found = new Set();
  const unknown = [];
  for (const p of parts) {
    const k = slotKey(p);
    if (k) found.add(k);
    else unknown.push(p);
  }
  return { keys: SLOT_KEYS.filter((k) => found.has(k)), unknown };
}

const questionId = (key) => `slot_${key}`;

/** The seven yes/no ("noul") questions, keyed slot_<key>. */
function buildSlotQuestions() {
  const questions = {};
  for (const s of SLOTS) {
    questions[questionId(s.key)] = {
      type: 'noul',
      instructions:
        `Is this recipe suitable to be served as ${s.name}? ${s.description} ` +
        'Answer yes if a dietician would reasonably serve it in that slot. A recipe can suit more than one slot, ' +
        'and it is fine to answer yes for several.',
    };
  }
  return questions;
}

/** Laya's answers -> { slotKey: probability of "yes" | null }. */
function slotProbabilities(answers) {
  const out = {};
  for (const k of SLOT_KEYS) {
    const a = answers && answers[questionId(k)];
    out[k] = a && typeof a.noul === 'number' ? a.noul : null;
  }
  return out;
}

/** The slot with the highest probability (ties go to the earlier slot), or null. */
function topSlot(probs) {
  let best = null;
  for (const k of SLOT_KEYS) {
    const p = probs && probs[k];
    if (typeof p === 'number' && (best === null || p > probs[best])) best = k;
  }
  return best;
}

module.exports = {
  SLOTS,
  SLOT_KEYS,
  SLOT_NAMES,
  slotKey,
  slotKeyFromServingTime,
  slotName,
  parseSlotList,
  questionId,
  buildSlotQuestions,
  slotProbabilities,
  topSlot,
};
