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
const {
  parseQuantitiesFromNote,
  applyAiNoteQuantityOverrides,
  preserveSubmittedIngredients,
} = require('./ingredientQuantityValidator');

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

// Regression coverage for the reported "Amla and Honey Tonic" bug:
// editing "Amla Juice" from 30ml to 20ml via the structured ingredient
// editor (not aiNote) came back from Update AI Inputs as "Amla" 2 piece,
// with "Honey" dropped from the list entirely and category silently
// changed - because the AI's regenerated `ingredients` replaced the
// dietician's submitted list wholesale instead of being diffed against it.
test('preserveSubmittedIngredients: reproduces and fixes the Amla Juice bug', () => {
  const submitted = [
    { name: 'Amla Juice', quantity: 20, unit: 'ml', category: 'Other', role: 'core' },
    { name: 'Water', quantity: 200, unit: 'ml', category: 'Other', role: 'sub' },
    { name: 'Honey', quantity: 1, unit: 'tsp', category: 'Sweetener', role: 'sub' },
  ];
  // What the model actually returned in the real bug report: renamed,
  // unit-converted, and dropped an ingredient entirely.
  const aiResponse = [
    { name: 'Amla', quantity: 2, unit: 'piece', category: 'Fruit', description: 'Rich in Vitamin C and antioxidants.' },
    { name: 'Water', quantity: 200, unit: 'ml', category: 'Other', description: 'Hydrates and dilutes the tonic.' },
  ];

  const result = preserveSubmittedIngredients(submitted, aiResponse);

  assert.strictEqual(result.length, 3, 'no ingredient should be silently dropped');
  const byName = Object.fromEntries(result.map((i) => [i.name, i]));
  assert.ok(byName['Amla Juice'], 'name must not be silently changed to "Amla"');
  assert.strictEqual(byName['Amla Juice'].quantity, 20);
  assert.strictEqual(byName['Amla Juice'].unit, 'ml');
  assert.strictEqual(byName['Honey'].quantity, 1);
  assert.strictEqual(byName['Honey'].unit, 'tsp');
});

test('preserveSubmittedIngredients: inherits AI-filled metadata for a matched ingredient', () => {
  const submitted = [{ name: 'Water', quantity: 200, unit: 'ml', role: 'sub' }];
  const aiResponse = [{ name: 'Water', quantity: 999, unit: 'cup', category: 'Other', description: 'Hydrates and dilutes the tonic.' }];

  const [result] = preserveSubmittedIngredients(submitted, aiResponse);

  // quantity/unit stay exactly as submitted, never the model's value...
  assert.strictEqual(result.quantity, 200);
  assert.strictEqual(result.unit, 'ml');
  // ...but descriptive metadata the dietician didn't set is still enriched.
  assert.strictEqual(result.description, 'Hydrates and dilutes the tonic.');
});

test('preserveSubmittedIngredients: keeps a genuinely new AI-added ingredient (e.g. from aiNote)', () => {
  const submitted = [{ name: 'Amla Juice', quantity: 20, unit: 'ml', role: 'core' }];
  const aiResponse = [
    { name: 'Amla Juice', quantity: 20, unit: 'ml', category: 'Other' },
    { name: 'Ginger', quantity: 1, unit: 'tsp', category: 'Spice', role: 'sub' },
  ];

  const result = preserveSubmittedIngredients(submitted, aiResponse);

  assert.strictEqual(result.length, 2);
  const ginger = result.find((i) => i.name === 'Ginger');
  assert.ok(ginger, 'a new ingredient the model added should be kept');
  assert.strictEqual(ginger.quantity, 1);
});

test('preserveSubmittedIngredients: role always comes from the submitted value, never the model', () => {
  const submitted = [{ name: 'Amla Juice', quantity: 20, unit: 'ml', role: 'core' }];
  const aiResponse = [{ name: 'Amla Juice', quantity: 20, unit: 'ml', role: 'sub' }];

  const [result] = preserveSubmittedIngredients(submitted, aiResponse);
  assert.strictEqual(result.role, 'core');
});

test('preserveSubmittedIngredients: handles empty/missing AI response gracefully', () => {
  const submitted = [{ name: 'Amla Juice', quantity: 20, unit: 'ml', role: 'core' }];
  assert.deepStrictEqual(
    preserveSubmittedIngredients(submitted, []).map((i) => i.name),
    ['Amla Juice']
  );
  assert.deepStrictEqual(
    preserveSubmittedIngredients(submitted, null).map((i) => i.name),
    ['Amla Juice']
  );
  assert.deepStrictEqual(preserveSubmittedIngredients([], null), []);
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
