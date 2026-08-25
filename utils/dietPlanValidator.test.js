/**
 * dietPlanValidator Tests
 * Plain assertion script (no framework), matching the project's existing
 * chat/tests/chat.test.js / ingredientQuantityValidator.test.js convention.
 * Run with: node utils/dietPlanValidator.test.js
 *
 * Regression coverage for the reported bug: patient "Geeta" got a plan
 * totaling 151 kcal against a 1687 kcal target, with "Chicken Curry" (a
 * Dinner recipe) scattered across Morning Drink/Breakfast/Brunch/Evening
 * Snack/Night Drink/Lunch. validateDietPlan already detected this at
 * generation time but only as a non-blocking warning; these tests cover
 * the new severity classification (severeIssues/hasSevereIssues) that now
 * lets the caller gate on it.
 */

const assert = require('assert');
const { validateDietPlan, formatSevereIssuesForPrompt, SEVERE_CALORIE_DEVIATION_TOLERANCE } = require('./dietPlanValidator');
const { DAY_GROUPS } = require('./dayGroups');
const { REQUIRED_SERVING_TIMES } = require('./dietPlanOptions');

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push({ name, passed: true });
  } catch (error) {
    results.push({ name, passed: false, error: error.message });
  }
}

// servingSize.quantity: 125 matters, not cosmetic - trendCalorieRatio
// (dietPlanValidator.js) rescales Lunch/Dinner/Evening Snack calories to
// model a realistic combo-served amount, using `target / baseQuantity`
// where target is 125 for a non-salad/non-piece recipe under a 'gain'
// weightTrend (the default these tests use). Setting quantity: 125 makes
// that ratio exactly 1, so these fixtures' raw `calories` values are what
// actually gets summed - without this, a recipe missing servingSize
// defaults baseQuantity to 1, inflating its calories by 125x.
const CHICKEN_CURRY = { id: 'dinner-curry', name: 'Chicken Curry', servingTime: 'Dinner', calories: 400, protein: 30, carbs: 10, fats: 20, tags: [], servingSize: { quantity: 125, unit: 'g' } };
const CHICKEN_BIRYANI = { id: 'lunch-biryani', name: 'Chicken Biryani', servingTime: 'Lunch', calories: 500, protein: 25, carbs: 60, fats: 15, tags: [], servingSize: { quantity: 125, unit: 'g' } };
const CHAPATI = { id: 'chapati-side', name: 'Chapati', servingTime: 'Lunch', calories: 120, protein: 3, carbs: 20, fats: 3, tags: ['side'], servingSize: { quantity: 125, unit: 'g' } };

// One dedicated, always-valid filler recipe per slot (own servingTime
// matches the slot exactly) so buildWeek can fully populate every
// untested slot without itself triggering spurious slot_mismatch warnings
// (unlike reusing CHAPATI - a Lunch-only side - which is only legitimately
// cross-listable into Lunch/Dinner, not every slot).
const FILLERS = {};
REQUIRED_SERVING_TIMES.forEach((servingTime) => {
  const fillerId = `filler-${servingTime.toLowerCase().replace(/\s+/g, '-')}`;
  FILLERS[servingTime] = {
    id: fillerId,
    name: `Filler ${servingTime}`,
    servingTime,
    calories: 150,
    protein: 5,
    carbs: 20,
    fats: 5,
    tags: [],
    servingSize: { quantity: 125, unit: 'g' },
  };
});

const RECIPE_POOL = [CHICKEN_CURRY, CHICKEN_BIRYANI, CHAPATI, ...Object.values(FILLERS)];

// Builds a fully-populated week (all 4 day-groups x all 7 slots) from a
// per-day-group meal-override map, so "missing slot" never false-fires in
// fixtures that aren't testing that specific check.
function buildWeek(weekNumber, overridesByDayGroup = {}) {
  const dailyMeals = [];
  DAY_GROUPS.forEach((dayGroup) => {
    const overrides = overridesByDayGroup[dayGroup] || {};
    REQUIRED_SERVING_TIMES.forEach((servingTime) => {
      if (overrides[servingTime] === null) return; // explicitly omitted, for missing-slot tests
      const recipeId = overrides[servingTime] || FILLERS[servingTime].id; // slot-correct filler by default
      dailyMeals.push({ dayGroup, servingTime, recipeId });
    });
  });
  return { week: weekNumber, dailyMeals };
}

test('reproduces the Geeta bug shape: hasSevereIssues is true with slot_mismatch entries for every wrong placement', () => {
  const badWeek = buildWeek(1, {
    Monday: {
      'Morning Drink': CHICKEN_CURRY.id,
      Breakfast: CHICKEN_CURRY.id,
      Brunch: CHICKEN_CURRY.id,
      'Evening Snack': CHICKEN_CURRY.id,
      'Night Drink': CHICKEN_CURRY.id,
      Lunch: CHICKEN_CURRY.id,
      Dinner: CHICKEN_BIRYANI.id,
    },
  });

  const result = validateDietPlan({
    parsedPlan: { weeks: [badWeek] },
    recipePool: RECIPE_POOL,
    calorieStrategy: { calorieBudget: 1687 },
    weightTrend: 'gain',
  });

  assert.strictEqual(result.hasSevereIssues, true);
  const slotMismatches = result.severeIssues.filter((i) => i.type === 'slot_mismatch');
  // Chicken Curry misplaced in 6 wrong slots (Morning Drink, Breakfast,
  // Brunch, Evening Snack, Night Drink, Lunch) + Chicken Biryani misplaced
  // in Dinner = 7 total mismatches.
  assert.strictEqual(slotMismatches.length, 7);
  assert.ok(slotMismatches.some((i) => i.recipeName === 'Chicken Curry' && i.assignedServingTime === 'Breakfast'));
  assert.ok(slotMismatches.some((i) => i.recipeName === 'Chicken Biryani' && i.assignedServingTime === 'Dinner'));
});

test('a clean, correctly-slotted plan (no calorie budget check involved) produces zero warnings and hasSevereIssues === false', () => {
  const goodWeek = buildWeek(1, {
    Monday: { Dinner: CHICKEN_CURRY.id, Lunch: CHICKEN_BIRYANI.id },
  });

  const result = validateDietPlan({
    parsedPlan: { weeks: [goodWeek] },
    recipePool: RECIPE_POOL,
    calorieStrategy: {}, // no calorieBudget - isolates this test to slot/missing-slot checks only
    weightTrend: 'gain',
  });

  assert.strictEqual(result.hasSevereIssues, false);
  assert.strictEqual(result.warnings.length, 0);
});

test('a >40% calorie deviation is severe (blocking); a 10-40% deviation is a soft warning only', () => {
  // Monday: Dinner=Curry (400) + 6 filler slots (150 each = 900) = 1300 total.
  // Tuesday/Wednesday/Thursday left empty so their 0-calorie totals are
  // skipped by the deviation check entirely (validateDietPlan returns early
  // for a day-group total <= 0) - isolates this test to Monday's number.
  const week = { week: 1, dailyMeals: [] };
  REQUIRED_SERVING_TIMES.forEach((servingTime) => {
    week.dailyMeals.push({
      dayGroup: 'Monday',
      servingTime,
      recipeId: servingTime === 'Dinner' ? CHICKEN_CURRY.id : FILLERS[servingTime].id,
    });
  });

  const severeResult = validateDietPlan({
    parsedPlan: { weeks: [week] },
    recipePool: RECIPE_POOL,
    calorieStrategy: { calorieBudget: 5000 }, // |1300-5000|/5000 = 74% deviation
    weightTrend: 'gain',
  });
  assert.ok(severeResult.hasSevereIssues);
  assert.ok(severeResult.severeIssues.some((i) => i.type === 'calorie_deviation_severe'));

  const softResult = validateDietPlan({
    parsedPlan: { weeks: [week] },
    recipePool: RECIPE_POOL,
    calorieStrategy: { calorieBudget: 1500 }, // |1300-1500|/1500 = 13.3% deviation - soft zone only
    weightTrend: 'gain',
  });
  assert.ok(softResult.warnings.some((w) => w.includes('deviate more than')));
  assert.ok(!softResult.severeIssues.some((i) => i.type === 'calorie_deviation_severe'));
});

test('a side-tagged recipe cross-listed into Dinner does NOT raise a slot_mismatch (legitimate combo)', () => {
  const week = buildWeek(1, { Monday: { Dinner: CHAPATI.id } }); // Chapati's own servingTime is Lunch

  const result = validateDietPlan({
    parsedPlan: { weeks: [week] },
    recipePool: RECIPE_POOL,
    calorieStrategy: {}, // no calorieBudget - isolates this test to the slot-mismatch check
    weightTrend: 'gain',
  });

  assert.ok(!result.severeIssues.some((i) => i.type === 'slot_mismatch' && i.recipeName === 'Chapati'));
});

test('a day-group missing all entries for a required slot raises a missing_slot severe issue', () => {
  const overrides = { Monday: { Lunch: null } }; // omit Monday's Lunch entirely
  const week = buildWeek(1, overrides);

  const result = validateDietPlan({
    parsedPlan: { weeks: [week] },
    recipePool: RECIPE_POOL,
    calorieStrategy: {},
    weightTrend: 'gain',
  });

  assert.ok(result.hasSevereIssues);
  assert.ok(
    result.severeIssues.some((i) => i.type === 'missing_slot' && i.dayGroup === 'Monday' && i.servingTime === 'Lunch')
  );
});

test('formatSevereIssuesForPrompt dedupes repeated slot_mismatch entries for the same recipe into one bullet', () => {
  const severeIssues = [
    { type: 'slot_mismatch', recipeName: 'Chicken Curry', recipeServingTime: 'Dinner', assignedServingTime: 'Breakfast', message: 'x' },
    { type: 'slot_mismatch', recipeName: 'Chicken Curry', recipeServingTime: 'Dinner', assignedServingTime: 'Lunch', message: 'x' },
    { type: 'slot_mismatch', recipeName: 'Chicken Curry', recipeServingTime: 'Dinner', assignedServingTime: 'Night Drink', message: 'x' },
    { type: 'missing_slot', message: 'Week 1, Monday: no meal entries found for required slot "Lunch".' },
  ];

  const note = formatSevereIssuesForPrompt(severeIssues);
  const lines = note.split('\n');

  assert.strictEqual(lines.length, 2);
  assert.ok(lines[0].includes('Chicken Curry'));
  assert.ok(lines[0].includes('Breakfast'));
  assert.ok(lines[0].includes('Lunch'));
  assert.ok(lines[0].includes('Night Drink'));
  assert.ok(lines[1].includes('missing_slot') === false); // raw message, not the type label
  assert.ok(lines[1].includes('no meal entries found'));
});

console.log('='.repeat(60));
console.log('dietPlanValidator Test Suite');
console.log('='.repeat(60));
for (const r of results) {
  console.log(`  ${r.passed ? 'PASS' : 'FAIL'} ${r.name}${r.error ? ` (${r.error})` : ''}`);
}
const passed = results.filter((r) => r.passed).length;
const failed = results.filter((r) => !r.passed).length;
console.log(`\nTotal: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
