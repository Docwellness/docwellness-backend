/**
 * Deterministic replacement for utils/openaiClient.js's generateDietPlanWithAI
 * - same input/output contract (see that function's signature) so
 * controllers/dietician/dietPlanController.js's runDietPlanGeneration can
 * call either producer interchangeably and reuse ALL of its surrounding
 * scaffolding unchanged: the retry loop, utils/dietPlanValidator.js,
 * utils/dietPlanRepair.js, risk-flagging, and the generatedPlan merge/save.
 * That validator becomes this engine's regression gate for free - the same
 * product rules (right-slot recipes, calorie budget, non-veg day-group
 * gating) the AI's output had to satisfy, an engine's output must satisfy
 * too, or runDietPlanGeneration rejects it exactly like a bad AI response.
 *
 * recipesByServingTime[slot] is the same recipeToPromptShape-mapped array
 * generateDietPlanWithAI receives (see dietPlanController.js's
 * recipePoolByServingTime) - each entry's OWN `servingTime` field (not the
 * slot key) distinguishes a slot's true "main dish" candidates from
 * recipes broadened in only because they're tagged side/salad (see
 * utils/dietPlanOptions.js's SIDE_SALAD_ELIGIBLE_SLOTS broadening) -
 * that's what lets selectMainAndAccompaniment below build a main+side combo
 * instead of ever picking a side dish as if it were the whole meal.
 */

const crypto = require('crypto');
const { DAY_GROUPS, NON_VEG_ALLOWED_DAY_GROUPS } = require('../utils/dayGroups');
const { SIDE_SALAD_ELIGIBLE_SLOTS } = require('../utils/dietPlanOptions');
const { slotCalorieTarget, calorieFitScore, macroFitScore } = require('./nutritionCalculatorService');

const REQUIRED_SERVING_TIMES = [
  'Morning Drink',
  'Breakfast',
  'Brunch',
  'Lunch',
  'Evening Snack',
  'Dinner',
  'Night Drink',
];

// Same recentness bands the design called for: a repeat within the last 2
// picks for this slot is penalized hard (adjacent day-groups), an earlier
// repeat within the same generation run more lightly.
const IMMEDIATE_REPEAT_WINDOW = 2;
const IMMEDIATE_REPEAT_PENALTY = 0.5;
const EARLIER_REPEAT_PENALTY = 0.2;

function seedFromString(str) {
  return parseInt(crypto.createHash('sha256').update(str).digest('hex').slice(0, 8), 16);
}

// Small deterministic PRNG (mulberry32) - reproducible given the same seed,
// which is what lets a regenerate-with-identical-inputs request produce the
// identical plan (same contract generateDietPlanWithAI's own seed comment
// documents: "a fresh seed per attempt would defeat the purpose").
function mulberry32(seed) {
  let t = seed >>> 0;
  return function () {
    t = (t + 0x6d2b79f5) | 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function varietyPenaltyFor(recipeId, recentlyUsed) {
  const indexFromEnd = [...recentlyUsed].reverse().indexOf(recipeId);
  if (indexFromEnd === -1) return 0;
  return indexFromEnd < IMMEDIATE_REPEAT_WINDOW ? IMMEDIATE_REPEAT_PENALTY : EARLIER_REPEAT_PENALTY;
}

function scoreCandidate({ recipe, target, macroStrategy, servingTime, recentlyUsed }) {
  const calFit = calorieFitScore({ recipeCalories: recipe.calories, target });
  const macFit = macroFitScore({ recipeMacros: recipe, macroStrategy });
  const suitability = (typeof recipe.mealSlotSuitability?.[servingTime] === 'number'
    ? recipe.mealSlotSuitability[servingTime]
    : 1);
  // Neutral (not zeroed) when macro data is unavailable, so a recipe
  // missing protein/carbs/fats isn't unfairly punished relative to ones
  // that have it - only calorie fit and suitability drive its score then.
  const macroComponent = macFit === null ? 0.3 : 0.3 * macFit;
  const penalty = varietyPenaltyFor(recipe.id, recentlyUsed);
  return suitability * (0.5 * calFit + macroComponent) - penalty;
}

/** Weighted-random pick among the top 3 scored candidates, seeded for reproducibility. */
function pickWeighted(scoredCandidates, rand) {
  const top = [...scoredCandidates].sort((a, b) => b.score - a.score).slice(0, 3);
  const weights = top.map((c) => Math.max(c.score, 0.001));
  const total = weights.reduce((a, b) => a + b, 0);
  let acc = 0;
  for (let i = 0; i < top.length; i++) {
    acc += weights[i] / total;
    if (rand <= acc) return top[i].recipe;
  }
  return top[0].recipe;
}

/**
 * Splits a slot's eligible pool into true "main" candidates (their own
 * stored servingTime matches this slot) vs accompaniment-only candidates
 * (tagged side/salad, broadened in from elsewhere) - see header comment.
 * For a slot with no true mains (only broadened-in recipes), every eligible
 * recipe is treated as a main candidate so the slot can still be filled.
 */
function selectMainAndAccompaniment({ eligible, servingTime, target, macroStrategy, recentlyUsed, rand }) {
  const mains = eligible.filter((r) => r.servingTime === servingTime);
  const mainPool = mains.length > 0 ? mains : eligible;

  const scoredMains = mainPool.map((recipe) => ({
    recipe,
    score: scoreCandidate({ recipe, target, macroStrategy, servingTime, recentlyUsed }),
  }));
  const main = pickWeighted(scoredMains, rand);

  let accompaniment = null;
  if (SIDE_SALAD_ELIGIBLE_SLOTS.has(servingTime)) {
    const accompaniments = eligible.filter(
      (r) => r.id !== main.id && Array.isArray(r.tags) && r.tags.some((t) => t === 'side' || t === 'salad')
    );
    if (accompaniments.length > 0) {
      const scoredAccompaniments = accompaniments.map((recipe) => ({
        recipe,
        score:
          (typeof recipe.mealSlotSuitability?.[servingTime] === 'number' ? recipe.mealSlotSuitability[servingTime] : 1) -
          varietyPenaltyFor(recipe.id, recentlyUsed),
      }));
      // Weighted-random among the top 3, same as the main dish above - NOT
      // a pure greedy top-1 pick. Every candidate here starts from the same
      // default suitability (1) whenever mealSlotSuitability is unset (the
      // common case - see buildEligibleV1Pool's callers), so a plain sort
      // only ever separates candidates once varietyPenaltyFor has already
      // penalized one of them; until then ties resolve by array order,
      // which means whichever accompaniment happens to sort first would win
      // EVERY call, day-group after day-group, once its penalty decays back
      // out of the immediate-repeat window - a structural repetition bug of
      // exactly the kind reported against Varan dominating every Lunch/
      // Dinner. pickWeighted's randomization is what actually rotates
      // through the tied candidates instead of locking onto one.
      accompaniment = pickWeighted(scoredAccompaniments, rand);
    }
  }

  return { main, accompaniment };
}

/**
 * Same signature/contract as utils/openaiClient.js's generateDietPlanWithAI
 * - see this file's header comment. `mealDistribution` is an additive extra
 * param (not part of the AI producer's signature) sourced from
 * dietPlan.targetProfile.mealDistribution when present; falls back to an
 * even split across REQUIRED_SERVING_TIMES otherwise (see
 * nutritionCalculatorService.slotCalorieTarget).
 */
async function generateDietPlanDeterministically({
  patient,
  firstConsultation,
  calorieStrategy,
  macroStrategy,
  recipesByServingTime = {},
  weekNumbers = [1, 2, 3, 4],
  restrictNonVegToDayGroups = false,
  mealDistribution = null,
}) {
  const totalCalories = calorieStrategy?.calorieBudget || null;
  const seedBase = seedFromString(
    JSON.stringify({
      patientId: patient?._id?.toString() || (typeof patient === 'string' ? patient : '') || '',
      firstConsultationId: firstConsultation?._id?.toString() || '',
      calorieStrategy: calorieStrategy || null,
      macroStrategy: macroStrategy || null,
      weekNumbers: [...weekNumbers].sort(),
    })
  );

  const recentlyUsedByServingTime = new Map();
  const weeks = [];

  for (const week of weekNumbers) {
    const dailyMeals = [];

    for (const dayGroup of DAY_GROUPS) {
      for (const servingTime of REQUIRED_SERVING_TIMES) {
        const pool = recipesByServingTime[servingTime] || [];
        const eligible =
          restrictNonVegToDayGroups && !NON_VEG_ALLOWED_DAY_GROUPS.includes(dayGroup)
            ? pool.filter((r) => !r.dietaryHabits?.nonVegetarian)
            : pool;

        if (eligible.length === 0) continue; // left unfillable - validateDietPlan surfaces missing coverage downstream

        const target = slotCalorieTarget({
          mealDistribution,
          servingTime,
          totalCalories,
          allServingTimes: REQUIRED_SERVING_TIMES,
        });
        const recentlyUsed = recentlyUsedByServingTime.get(servingTime) || [];
        const rand = mulberry32(seedFromString(`${seedBase}-${week}-${dayGroup}-${servingTime}`))();

        const { main, accompaniment } = selectMainAndAccompaniment({
          eligible,
          servingTime,
          target,
          macroStrategy,
          recentlyUsed,
          rand,
        });

        dailyMeals.push({ dayGroup, servingTime, recipeId: main.id });
        recentlyUsed.push(main.id);
        if (accompaniment) {
          dailyMeals.push({ dayGroup, servingTime, recipeId: accompaniment.id });
          recentlyUsed.push(accompaniment.id);
        }
        recentlyUsedByServingTime.set(servingTime, recentlyUsed);
      }
    }

    weeks.push({ week, dailyMeals });
  }

  return JSON.stringify({ weeks });
}

module.exports = {
  generateDietPlanDeterministically,
  mulberry32,
  seedFromString,
  varietyPenaltyFor,
  scoreCandidate,
  pickWeighted,
  selectMainAndAccompaniment,
};
