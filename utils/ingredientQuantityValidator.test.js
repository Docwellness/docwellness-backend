/**
 * ingredientQuantityValidator Tests
 * Plain assertion script (no framework), matching the project's existing
 * chat/tests/chat.test.js convention. Run with: node utils/ingredientQuantityValidator.test.js
 *
 * Regression coverage for the reported bug: a dietician-specified quinoa
 * quantity in Custom Ingredients/Preferences ("1 cup quinoa") fluctuated
 * between "185g" and "1 cup" across repeated AI recipe generations.
 */

const assert = require('assert');
const { parseQuantitiesFromNote, applyAiNoteQuantityOverrides } = require('./ingredientQuantityValidator');

const results = [];

function test(name, fn) {
  try {
    fn();
    results.push({ name, passed: true });
  } catch (error) {
    results.push({ name, passed: false, error: error.message });
  }
}

const REPORTED_NOTE_FLAT =
  '½ cup chickpeas, ½ tomato, ¼ cup onion, ½ avocado, 1 cup quinoa, spinach, handful chopped kale; ' +
  'dressing: 1 lemon, 1½ tbs mustard, salt, extra virgin olive oil';

const REPORTED_NOTE_BULLETED = `- ½ cup chick peas
- ½ tomato
- ¼ cup onion
- ½ avocado
- 1 cup quinoa
- Spinach
- Handful of chopped kale

Dressing:
- Squeeze 1 lemon
- 1 ½ tbs mustard
- Salt
- Extra virgin olive oil`;

test('parseQuantitiesFromNote extracts expected tuples from the reported note', () => {
  const tuples = parseQuantitiesFromNote(REPORTED_NOTE_FLAT);
  const find = (token) => tuples.find((t) => t.ingredientToken === token);

  assert.deepStrictEqual(find('chickpeas'), { ingredientToken: 'chickpeas', quantity: 0.5, unit: 'cup' });
  assert.deepStrictEqual(find('onion'), { ingredientToken: 'onion', quantity: 0.25, unit: 'cup' });
  assert.deepStrictEqual(find('quinoa'), { ingredientToken: 'quinoa', quantity: 1, unit: 'cup' });
  assert.deepStrictEqual(find('mustard'), { ingredientToken: 'mustard', quantity: 1.5, unit: 'tbsp' });
});

test('parseQuantitiesFromNote handles the exact bulleted multi-line format the dietician typed', () => {
  const tuples = parseQuantitiesFromNote(REPORTED_NOTE_BULLETED);
  const quinoa = tuples.find((t) => t.ingredientToken === 'quinoa');
  const mustard = tuples.find((t) => t.ingredientToken === 'mustard');
  const lemon = tuples.find((t) => t.ingredientToken === 'lemon');

  assert.strictEqual(quinoa.quantity, 1);
  assert.strictEqual(quinoa.unit, 'cup');
  assert.strictEqual(mustard.quantity, 1.5);
  assert.strictEqual(mustard.unit, 'tbsp');
  assert.strictEqual(lemon.quantity, 1);
});

test('applyAiNoteQuantityOverrides normalizes both observed conflicting model outputs to the same value', () => {
  const outputAs185g = [{ name: 'Quinoa', quantity: 185, unit: 'g' }];
  const outputAs1Cup = [{ name: 'Quinoa', quantity: 1, unit: 'cup' }];

  const corrected185g = applyAiNoteQuantityOverrides({ aiNote: REPORTED_NOTE_FLAT, ingredients: outputAs185g, servings: 1 });
  const corrected1Cup = applyAiNoteQuantityOverrides({ aiNote: REPORTED_NOTE_FLAT, ingredients: outputAs1Cup, servings: 1 });

  assert.deepStrictEqual(corrected185g.ingredients[0], { name: 'Quinoa', quantity: 1, unit: 'cup' });
  assert.deepStrictEqual(corrected1Cup.ingredients[0], { name: 'Quinoa', quantity: 1, unit: 'cup' });
  assert.strictEqual(corrected185g.appliedOverrides.length, 1);
  assert.strictEqual(corrected1Cup.appliedOverrides.length, 0); // already correct, no override needed
});

test('applyAiNoteQuantityOverrides matches "chick peas" (as the dietician typed it) against the AI\'s "Chickpeas"', () => {
  const output = [{ name: 'Chickpeas', quantity: 185, unit: 'g' }];
  const { ingredients, appliedOverrides } = applyAiNoteQuantityOverrides({
    aiNote: REPORTED_NOTE_BULLETED,
    ingredients: output,
    servings: 1,
  });

  assert.deepStrictEqual(ingredients[0], { name: 'Chickpeas', quantity: 0.5, unit: 'cup' });
  assert.strictEqual(appliedOverrides.length, 1);
});

test('applyAiNoteQuantityOverrides scales the overridden per-serving amount by servings', () => {
  const output = [{ name: 'Quinoa', quantity: 185, unit: 'g' }];
  const { ingredients } = applyAiNoteQuantityOverrides({ aiNote: REPORTED_NOTE_FLAT, ingredients: output, servings: 3 });

  assert.strictEqual(ingredients[0].quantity, 3); // 1 cup/serving * 3 servings
  assert.strictEqual(ingredients[0].unit, 'cup');
});

test('applyAiNoteQuantityOverrides does not touch ingredients the note gives no explicit quantity for', () => {
  const output = [{ name: 'Sea Salt', quantity: 5, unit: 'g' }];
  const { ingredients, appliedOverrides } = applyAiNoteQuantityOverrides({
    aiNote: REPORTED_NOTE_FLAT, // mentions "salt" with no quantity
    ingredients: output,
    servings: 1,
  });

  assert.deepStrictEqual(ingredients[0], { name: 'Sea Salt', quantity: 5, unit: 'g' });
  assert.strictEqual(appliedOverrides.length, 0);
});

test('parseQuantitiesFromNote returns empty array for empty/missing note', () => {
  assert.deepStrictEqual(parseQuantitiesFromNote(''), []);
  assert.deepStrictEqual(parseQuantitiesFromNote(null), []);
  assert.deepStrictEqual(parseQuantitiesFromNote(undefined), []);
});

console.log('='.repeat(60));
console.log('ingredientQuantityValidator Test Suite');
console.log('='.repeat(60));
for (const r of results) {
  console.log(`  ${r.passed ? 'PASS' : 'FAIL'} ${r.name}${r.error ? ` (${r.error})` : ''}`);
}
const passed = results.filter((r) => r.passed).length;
const failed = results.filter((r) => !r.passed).length;
console.log(`\nTotal: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
