/**
 * The seven serving slots and the per-slot questions Laya answers
 * (utils/layaSlots.js). Slots are the Recipe.servingTime values, so these tests
 * also pin the list against the model's enum: if a slot is added to the model
 * and not here, Laya would silently never be asked about it.
 */

const {
  SLOTS,
  SLOT_KEYS,
  SLOT_NAMES,
  slotKey,
  slotKeyFromServingTime,
  slotName,
  parseSlotList,
  buildSlotQuestions,
  buildSlotChoiceQuestion,
  slotAnswerMode,
  slotProbabilities,
  topSlot,
} = require('../utils/layaSlots');

describe('the seven slots', () => {
  it('match Recipe.servingTime exactly, in the model\'s order', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'models', 'Recipe.js'), 'utf8');
    const enumBlock = src.slice(src.indexOf('servingTime: {'), src.indexOf('required: true', src.indexOf('servingTime: {')));
    const names = [...enumBlock.matchAll(/'([^']+)'/g)].map((m) => m[1]).filter((n) => n !== 'String');
    expect(SLOT_NAMES).toEqual(names);
  });

  it('have a stable key, a name and a description each', () => {
    expect(SLOT_KEYS).toEqual(['morning_drink', 'breakfast', 'brunch', 'lunch', 'evening_snack', 'dinner', 'night_drink']);
    for (const s of SLOTS) expect(s.description.length).toBeGreaterThan(20);
  });
});

describe('slotKey / slotKeyFromServingTime / slotName', () => {
  it('accepts names, keys and the aliases a reviewer might type', () => {
    expect(slotKey('Evening Snack')).toBe('evening_snack');
    expect(slotKey('  evening   snack ')).toBe('evening_snack');
    expect(slotKey('snack')).toBe('evening_snack');
    expect(slotKey('night_drink')).toBe('night_drink');
    expect(slotKey('LUNCH')).toBe('lunch');
    expect(slotKey('elevenses')).toBeNull();
    expect(slotKey(null)).toBeNull();
  });
  it('maps Recipe.servingTime exactly (no aliases) and names a key', () => {
    expect(slotKeyFromServingTime('Morning Drink')).toBe('morning_drink');
    expect(slotKeyFromServingTime('Brunch')).toBe('brunch');
    expect(slotKeyFromServingTime('snack')).toBeNull(); // servingTime is an enum, not free text
    expect(slotName('night_drink')).toBe('Night Drink');
  });
});

describe('parseSlotList', () => {
  it('reads a ";"-separated list into canonical order, de-duplicated', () => {
    expect(parseSlotList('Dinner; Lunch; lunch')).toEqual({ keys: ['lunch', 'dinner'], unknown: [] });
    expect(parseSlotList('Breakfast, Brunch')).toEqual({ keys: ['breakfast', 'brunch'], unknown: [] });
    expect(parseSlotList('Night Drink / Evening Snack')).toEqual({ keys: ['evening_snack', 'night_drink'], unknown: [] });
  });
  it('reports names that are not slots instead of dropping them', () => {
    expect(parseSlotList('Lunch; Teatime; ')).toEqual({ keys: ['lunch'], unknown: ['Teatime'] });
    expect(parseSlotList('')).toEqual({ keys: [], unknown: [] });
  });
});

describe('buildSlotQuestions', () => {
  const q = buildSlotQuestions();
  it('asks one yes/no (noul) question per slot, keyed slot_<key>', () => {
    expect(Object.keys(q)).toEqual(SLOT_KEYS.map((k) => `slot_${k}`));
    for (const v of Object.values(q)) expect(v.type).toBe('noul');
  });
  it('names the slot and says a recipe can suit several', () => {
    expect(q.slot_morning_drink.instructions).toMatch(/suitable to be served as Morning Drink/);
    expect(q.slot_dinner.instructions).toMatch(/can suit more than one slot/);
  });
});

describe('slotProbabilities / topSlot', () => {
  const answers = {
    slot_lunch: { type: 'noul', noul: 0.8 },
    slot_dinner: { type: 'noul', noul: 0.8 },
    slot_brunch: { type: 'noul', noul: 0.2 },
    protein_level: { type: 'choice', choice: 'low' },
  };
  it('reads each slot\'s probability, with null where Laya gave none', () => {
    const p = slotProbabilities(answers);
    expect(p.lunch).toBe(0.8);
    expect(p.brunch).toBe(0.2);
    expect(p.night_drink).toBeNull();
    expect(Object.keys(p)).toEqual(SLOT_KEYS);
  });
  it('picks the highest probability, ties to the earlier slot, null when nothing was answered', () => {
    expect(topSlot(slotProbabilities(answers))).toBe('lunch');
    expect(topSlot(slotProbabilities({}))).toBeNull();
  });
});

describe('the one-question (choice) form', () => {
  const q = buildSlotChoiceQuestion();
  it('is a single choice question whose options are the seven slot keys', () => {
    expect(Object.keys(q)).toEqual(['slot_fit']);
    expect(q.slot_fit.type).toBe('choice');
    expect(Object.keys(q.slot_fit.criteria)).toEqual(SLOT_KEYS);
    expect(q.slot_fit.criteria.dinner).toMatch(/evening meal/);
  });
  const answers = { slot_fit: { type: 'choice', choice: 'lunch', confidence: 0.3, probabilities: { morning_drink: 0.1, breakfast: 0.2, brunch: 0.1, lunch: 0.3, evening_snack: 0.1, dinner: 0.15, night_drink: 0.05 } } };
  it('reads the per-option probabilities as the slot scores', () => {
    const p = slotProbabilities(answers);
    expect(p.lunch).toBe(0.3);
    expect(p.night_drink).toBe(0.05);
    expect(topSlot(p)).toBe('lunch');
  });
  it('tells the two answer forms apart', () => {
    expect(slotAnswerMode(answers)).toBe('choice');
    expect(slotAnswerMode({ slot_lunch: { type: 'noul', noul: 0.4 } })).toBe('noul');
    expect(slotAnswerMode({ protein_level: { choice: 'low' } })).toBeNull();
    expect(slotAnswerMode(null)).toBeNull();
  });
});
