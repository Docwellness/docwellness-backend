/**
 * dietPlanOptions Tests
 * Plain assertion script (no framework), matching the project's existing
 * chat/tests/chat.test.js / ingredientQuantityValidator.test.js convention.
 * Run with: node utils/dietPlanOptions.test.js
 *
 * Regression coverage for the reported bug: the AI diet-plan generator was
 * handed one flat, unfiltered recipe pool and put a Dinner-only recipe
 * ("Chicken Curry") in Breakfast/Lunch/etc. buildRecipesByServingTimeMap is
 * the function that now makes that structurally impossible by bucketing
 * recipes per eligible slot before they ever reach the prompt.
 */

const assert = require('assert');
const { buildRecipesByServingTimeMap, SIDE_SALAD_ELIGIBLE_SLOTS } = require('./dietPlanOptions');

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push({ name, passed: true });
  } catch (error) {
    results.push({ name, passed: false, error: error.message });
  }
}

const id = (n) => ({ toString: () => n });

const dinnerCurry = { _id: id('dinner-curry'), name: 'Chicken Curry', servingTime: 'Dinner', tags: [], category: 'Indian' };
const lunchBiryani = { _id: id('lunch-biryani'), name: 'Chicken Biryani', servingTime: 'Lunch', tags: [], category: 'Indian' };
const chapatiSide = { _id: id('chapati-side'), name: 'Chapati', servingTime: 'Lunch', tags: ['side'], category: 'Indian' };
const saladItem = { _id: id('salad-item'), name: 'Kachumber Salad', servingTime: 'Lunch', tags: ['salad'], category: 'Indian' };
const multivitamin = { _id: id('multivitamin'), name: 'Multivitamin', servingTime: 'Night Drink', tags: [], category: 'Supplements' };

const fixtureDocs = [dinnerCurry, lunchBiryani, chapatiSide, saladItem, multivitamin];

test('a Dinner-only recipe appears ONLY under the Dinner bucket', () => {
  const map = buildRecipesByServingTimeMap(fixtureDocs);
  assert.ok(map.Dinner.some((r) => r._id.toString() === 'dinner-curry'));
  ['Breakfast', 'Morning Drink', 'Brunch', 'Evening Snack', 'Night Drink', 'Lunch'].forEach((slot) => {
    if (slot === 'Dinner') return;
    const bucket = map[slot] || [];
    assert.ok(
      !bucket.some((r) => r._id.toString() === 'dinner-curry'),
      `Chicken Curry (Dinner) leaked into the ${slot} bucket`
    );
  });
});

test('a Lunch-only recipe appears ONLY under the Lunch bucket', () => {
  const map = buildRecipesByServingTimeMap(fixtureDocs);
  assert.ok(map.Lunch.some((r) => r._id.toString() === 'lunch-biryani'));
  assert.ok(!(map.Dinner || []).some((r) => r._id.toString() === 'lunch-biryani'));
  assert.ok(!(map.Breakfast || []).some((r) => r._id.toString() === 'lunch-biryani'));
});

test('side/salad recipes cross-list into Lunch and Dinner only', () => {
  const map = buildRecipesByServingTimeMap(fixtureDocs);
  [...SIDE_SALAD_ELIGIBLE_SLOTS].forEach((slot) => {
    assert.ok(map[slot].some((r) => r._id.toString() === 'chapati-side'), `Chapati missing from ${slot}`);
    assert.ok(map[slot].some((r) => r._id.toString() === 'salad-item'), `Salad missing from ${slot}`);
  });
  ['Breakfast', 'Morning Drink', 'Brunch', 'Night Drink', 'Evening Snack'].forEach((slot) => {
    const bucket = map[slot] || [];
    assert.ok(!bucket.some((r) => r._id.toString() === 'chapati-side'), `Chapati leaked into ${slot}`);
  });
});

test('a Supplements-category recipe appears under its own real servingTime AND the Supplements pseudo-slot', () => {
  const map = buildRecipesByServingTimeMap(fixtureDocs);
  assert.ok(map['Night Drink'].some((r) => r._id.toString() === 'multivitamin'));
  assert.ok(map.Supplements.some((r) => r._id.toString() === 'multivitamin'));
});

console.log('='.repeat(60));
console.log('dietPlanOptions Test Suite');
console.log('='.repeat(60));
for (const r of results) {
  console.log(`  ${r.passed ? 'PASS' : 'FAIL'} ${r.name}${r.error ? ` (${r.error})` : ''}`);
}
const passed = results.filter((r) => r.passed).length;
const failed = results.filter((r) => !r.passed).length;
console.log(`\nTotal: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
