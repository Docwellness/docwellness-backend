/**
 * Manual live-API verification that AI recipe generation is no longer
 * "fluctuating" - reproduces the exact reported bug scenario (a Chickpeas
 * Salad with explicit ingredient quantities in Custom Ingredients/Preferences,
 * where quinoa flip-flopped between "185g" and "1 cup" across repeated
 * generations), plus the serving-time calorie calibration and servings-vs-
 * servingTime independence.
 *
 * Hits the live OpenAI API (real cost/time) - run manually, not in CI:
 *   node scripts/verify-recipe-determinism.js
 */

require('dotenv').config();
const { generateRecipeWithAI } = require('../utils/openaiClient');

const RUNS_PER_CHECK = 10;

const REPORTED_NOTE =
  '½ cup chickpeas, ½ tomato, ¼ cup onion, ½ avocado, 1 cup quinoa, spinach, handful chopped kale; ' +
  'dressing: 1 lemon, 1½ tbs mustard, salt, extra virgin olive oil';

const CALORIE_BANDS = {
  'Morning Drink': [50, 120],
  Breakfast: [250, 400],
  Brunch: [300, 450],
  Lunch: [450, 650],
  'Evening Snack': [100, 200],
  Dinner: [400, 600],
  'Night Drink': [50, 120],
};

function findIngredient(recipe, nameSubstring) {
  return recipe.ingredients.find((i) => i.name.toLowerCase().includes(nameSubstring.toLowerCase()));
}

async function checkQuantityConsistency() {
  console.log(`\n[1/3] Quantity consistency across ${RUNS_PER_CHECK} runs (Lunch, servings=1)`);
  const base = { name: 'Chickpeas Salad', servingTime: 'Lunch', servings: 1, dietaryHabits: {}, freeFrom: {}, aiNote: REPORTED_NOTE, languages: ['English'] };

  const seen = new Set();
  for (let i = 1; i <= RUNS_PER_CHECK; i++) {
    const recipe = await generateRecipeWithAI(base);
    const quinoa = findIngredient(recipe, 'quinoa');
    const chickpeas = findIngredient(recipe, 'chickpea');
    const key = `quinoa=${quinoa?.quantity}${quinoa?.unit} chickpeas=${chickpeas?.quantity}${chickpeas?.unit} calories=${recipe.nutrition.calories}`;
    seen.add(key);
    console.log(`  run ${i}: ${key}`);
  }

  if (seen.size === 1) {
    console.log(`  PASS - all ${RUNS_PER_CHECK} runs identical`);
  } else {
    console.log(`  FAIL - ${seen.size} distinct variations observed (expected 1)`);
  }
}

async function checkServingTimeCalibration() {
  console.log('\n[2/3] Serving-time calorie calibration (no aiNote, so the model has full freedom)');
  const base = { name: 'Chickpeas Salad', dietaryHabits: {}, freeFrom: {}, languages: ['English'] };

  let allPass = true;
  for (const [servingTime, [min, max]] of Object.entries(CALORIE_BANDS)) {
    const recipe = await generateRecipeWithAI({ ...base, servingTime, servings: 1 });
    const cal = recipe.nutrition.calories;
    const inBand = cal >= min && cal <= max;
    if (!inBand) allPass = false;
    console.log(`  ${servingTime}: ${cal} kcal (target ${min}-${max}) ${inBand ? 'PASS' : 'FAIL'}`);
  }
  console.log(allPass ? '  PASS - all serving times within their calorie band' : '  FAIL - see above');
}

async function checkServingsScaling() {
  console.log('\n[3/3] Servings vs Serving Time independence (Lunch, servings=1 vs 2 vs 3)');
  const base = { name: 'Chickpeas Salad', servingTime: 'Lunch', dietaryHabits: {}, freeFrom: {}, aiNote: REPORTED_NOTE, languages: ['English'] };

  const r1 = await generateRecipeWithAI({ ...base, servings: 1 });
  const r2 = await generateRecipeWithAI({ ...base, servings: 2 });
  const r3 = await generateRecipeWithAI({ ...base, servings: 3 });

  const q1 = findIngredient(r1, 'quinoa').quantity;
  const q2 = findIngredient(r2, 'quinoa').quantity;
  const q3 = findIngredient(r3, 'quinoa').quantity;

  console.log(`  quinoa: servings=1 -> ${q1}, servings=2 -> ${q2}, servings=3 -> ${q3}`);
  console.log(`  calories (should stay ~flat, per-serving): ${r1.nutrition.calories}, ${r2.nutrition.calories}, ${r3.nutrition.calories}`);

  const scalesLinearly = q2 === q1 * 2 && q3 === q1 * 3;
  console.log(scalesLinearly ? '  PASS - ingredient quantities scale linearly with servings' : '  FAIL - quantities did not scale as expected');
}

(async () => {
  console.log('='.repeat(70));
  console.log('AI Recipe Determinism Verification (live API - costs tokens/time)');
  console.log('='.repeat(70));

  await checkQuantityConsistency();
  await checkServingTimeCalibration();
  await checkServingsScaling();

  console.log('\nDone.');
})();
