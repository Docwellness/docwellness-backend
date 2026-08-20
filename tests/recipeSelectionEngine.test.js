/**
 * services/recipeSelectionEngine.js - the deterministic replacement for
 * utils/openaiClient.js's generateDietPlanWithAI. Pure-data unit tests (no
 * DB) plus the explicit "don't break flow/results" regression gate: the
 * engine's own output must independently pass utils/dietPlanValidator.js,
 * the same check the AI's output has always had to pass.
 */

const {
  generateDietPlanDeterministically,
  varietyPenaltyFor,
  scoreCandidate,
  pickWeighted,
  selectMainAndAccompaniment,
} = require('../services/recipeSelectionEngine');
const { validateDietPlan } = require('../utils/dietPlanValidator');
const { DAY_GROUPS, NON_VEG_ALLOWED_DAY_GROUPS } = require('../utils/dayGroups');

const REQUIRED_SERVING_TIMES = [
  'Morning Drink',
  'Breakfast',
  'Brunch',
  'Lunch',
  'Evening Snack',
  'Dinner',
  'Night Drink',
];

function recipe(id, overrides = {}) {
  return {
    id,
    name: id,
    servingTime: 'Breakfast',
    calories: 300,
    protein: 15,
    carbs: 30,
    fats: 10,
    dietaryHabits: {},
    freeFrom: {},
    tags: [],
    mealSlotSuitability: {},
    // A realistic gram quantity, not a degenerate 1 - utils/dietPlanValidator.js's
    // trendCalorieRatio scales a slot's estimated calories by
    // (a fixed target gram amount / this quantity), so quantity:1 would
    // blow that ratio up ~125x and trip its severe-deviation check on
    // otherwise-correct data.
    components: [{ label: id, quantity: 150, unit: 'g' }],
    ...overrides,
  };
}

/** A recipe pool with 2 real candidates for every required slot, no sides/salads/non-veg. */
function basicPoolByServingTime() {
  const pool = {};
  REQUIRED_SERVING_TIMES.forEach((slot) => {
    pool[slot] = [
      recipe(`${slot}-A`, { servingTime: slot, calories: 300 }),
      recipe(`${slot}-B`, { servingTime: slot, calories: 320 }),
    ];
  });
  return pool;
}

describe('varietyPenaltyFor', () => {
  test('no penalty when the recipe has not been used recently', () => {
    expect(varietyPenaltyFor('r1', [])).toBe(0);
    expect(varietyPenaltyFor('r1', ['r2', 'r3'])).toBe(0);
  });

  test('heavy penalty for a repeat within the immediate window', () => {
    expect(varietyPenaltyFor('r1', ['r1'])).toBeGreaterThan(0.3);
    expect(varietyPenaltyFor('r1', ['r2', 'r1'])).toBeGreaterThan(0.3);
  });

  test('lighter (flat) penalty once a repeat falls outside the immediate window', () => {
    // IMMEDIATE_REPEAT_WINDOW is 2 - distance-from-end 0 or 1 is "immediate",
    // 2+ is "earlier" and gets the same flat, lighter penalty (not a
    // continuing gradient).
    const immediate = varietyPenaltyFor('r1', ['r1', 'r2']); // distance 1
    const earlier = varietyPenaltyFor('r1', ['r1', 'r2', 'r3']); // distance 2
    const evenEarlier = varietyPenaltyFor('r1', ['r1', 'r2', 'r3', 'r4']); // distance 3
    expect(earlier).toBeLessThan(immediate);
    expect(earlier).toBeGreaterThan(0);
    expect(evenEarlier).toBe(earlier);
  });
});

describe('scoreCandidate', () => {
  test('scores an exact calorie match higher than a poor one, all else equal', () => {
    const good = recipe('good', { calories: 400 });
    const bad = recipe('bad', { calories: 900 });
    const scoreGood = scoreCandidate({ recipe: good, target: 400, macroStrategy: null, servingTime: 'Lunch', recentlyUsed: [] });
    const scoreBad = scoreCandidate({ recipe: bad, target: 400, macroStrategy: null, servingTime: 'Lunch', recentlyUsed: [] });
    expect(scoreGood).toBeGreaterThan(scoreBad);
  });

  test('a higher mealSlotSuitability weight increases the score, all else equal', () => {
    const low = recipe('low', { calories: 400, mealSlotSuitability: { Lunch: 0.3 } });
    const high = recipe('high', { calories: 400, mealSlotSuitability: { Lunch: 1.0 } });
    const args = { target: 400, macroStrategy: null, servingTime: 'Lunch', recentlyUsed: [] };
    expect(scoreCandidate({ recipe: high, ...args })).toBeGreaterThan(scoreCandidate({ recipe: low, ...args }));
  });

  test('recent use lowers the score via the variety penalty', () => {
    const r = recipe('r1', { calories: 400 });
    const args = { recipe: r, target: 400, macroStrategy: null, servingTime: 'Lunch' };
    expect(scoreCandidate({ ...args, recentlyUsed: ['r1'] })).toBeLessThan(
      scoreCandidate({ ...args, recentlyUsed: [] })
    );
  });
});

describe('pickWeighted', () => {
  test('rand=0 always picks the top-scored candidate', () => {
    const candidates = [
      { recipe: recipe('low'), score: 0.1 },
      { recipe: recipe('high'), score: 0.9 },
      { recipe: recipe('mid'), score: 0.5 },
    ];
    expect(pickWeighted(candidates, 0).id).toBe('high');
  });

  test('rand close to 1 can pick a lower-scored candidate', () => {
    const candidates = [
      { recipe: recipe('high'), score: 0.9 },
      { recipe: recipe('low'), score: 0.05 },
    ];
    // With rand near 1, cumulative weight must pass through the second
    // (lower) candidate's slice - only possible if it's reachable at all.
    const picks = new Set();
    for (let r = 0; r <= 1; r += 0.05) picks.add(pickWeighted(candidates, r).id);
    expect(picks.has('low')).toBe(true);
    expect(picks.has('high')).toBe(true);
  });
});

describe('selectMainAndAccompaniment', () => {
  test('picks a true slot-owner as main, not a broadened-in side/salad', () => {
    const eligible = [
      recipe('rice', { servingTime: 'Lunch', calories: 400 }),
      recipe('chapati-side', { servingTime: 'Lunch', calories: 100, tags: ['side'] }),
    ];
    const { main } = selectMainAndAccompaniment({
      eligible,
      servingTime: 'Lunch',
      target: 400,
      macroStrategy: null,
      recentlyUsed: [],
      rand: 0,
    });
    expect(main.id).toBe('rice');
  });

  test('attaches a side/salad accompaniment for an eligible slot when available', () => {
    const eligible = [
      recipe('rice', { servingTime: 'Lunch', calories: 400 }),
      recipe('salad1', { servingTime: 'Lunch', calories: 50, tags: ['salad'] }),
    ];
    const { main, accompaniment } = selectMainAndAccompaniment({
      eligible,
      servingTime: 'Lunch',
      target: 400,
      macroStrategy: null,
      recentlyUsed: [],
      rand: 0,
    });
    expect(main.id).toBe('rice');
    expect(accompaniment.id).toBe('salad1');
  });

  test('never attaches an accompaniment for a slot outside SIDE_SALAD_ELIGIBLE_SLOTS', () => {
    const eligible = [
      recipe('poha', { servingTime: 'Breakfast', calories: 300 }),
      recipe('side-tagged', { servingTime: 'Breakfast', calories: 50, tags: ['side'] }),
    ];
    const { accompaniment } = selectMainAndAccompaniment({
      eligible,
      servingTime: 'Breakfast',
      target: 300,
      macroStrategy: null,
      recentlyUsed: [],
      rand: 0,
    });
    expect(accompaniment).toBeNull();
  });

  test('falls back to the full eligible pool as mains when no true slot-owner exists', () => {
    // Every candidate is only broadened in (own servingTime is Lunch, not Dinner).
    const eligible = [recipe('side-only', { servingTime: 'Lunch', calories: 200, tags: ['side'] })];
    const { main } = selectMainAndAccompaniment({
      eligible,
      servingTime: 'Dinner',
      target: 200,
      macroStrategy: null,
      recentlyUsed: [],
      rand: 0,
    });
    expect(main.id).toBe('side-only');
  });
});

describe('generateDietPlanDeterministically', () => {
  test('fills every required slot for every day-group and requested week', async () => {
    const text = await generateDietPlanDeterministically({
      patient: { _id: 'p1' },
      firstConsultation: { _id: 'c1' },
      calorieStrategy: { calorieBudget: 1800 },
      macroStrategy: { proteinPercent: 30, carbsPercent: 40, fatPercent: 30 },
      recipesByServingTime: basicPoolByServingTime(),
      weekNumbers: [1, 2],
    });
    const parsed = JSON.parse(text);

    expect(parsed.weeks.map((w) => w.week)).toEqual([1, 2]);
    for (const week of parsed.weeks) {
      for (const dayGroup of DAY_GROUPS) {
        for (const slot of REQUIRED_SERVING_TIMES) {
          const hasSlot = week.dailyMeals.some((m) => m.dayGroup === dayGroup && m.servingTime === slot);
          expect(hasSlot).toBe(true);
        }
      }
    }
  });

  test('leaves a slot unfilled (not crashing) when its pool is empty', async () => {
    const pool = basicPoolByServingTime();
    delete pool['Night Drink'];
    const text = await generateDietPlanDeterministically({
      patient: { _id: 'p1' },
      calorieStrategy: { calorieBudget: 1800 },
      recipesByServingTime: pool,
      weekNumbers: [1],
    });
    const parsed = JSON.parse(text);
    expect(parsed.weeks[0].dailyMeals.some((m) => m.servingTime === 'Night Drink')).toBe(false);
  });

  test('never places a non-veg recipe outside Monday/Wednesday when restrictNonVegToDayGroups is true', async () => {
    const pool = basicPoolByServingTime();
    pool.Lunch = [
      recipe('veg-lunch', { servingTime: 'Lunch', calories: 400 }),
      recipe('nonveg-lunch', { servingTime: 'Lunch', calories: 400, dietaryHabits: { nonVegetarian: true } }),
    ];
    const text = await generateDietPlanDeterministically({
      patient: { _id: 'p1' },
      calorieStrategy: { calorieBudget: 1800 },
      recipesByServingTime: pool,
      weekNumbers: [1, 2, 3],
      restrictNonVegToDayGroups: true,
    });
    const parsed = JSON.parse(text);

    for (const week of parsed.weeks) {
      for (const meal of week.dailyMeals) {
        if (meal.recipeId === 'nonveg-lunch') {
          expect(NON_VEG_ALLOWED_DAY_GROUPS).toContain(meal.dayGroup);
        }
      }
    }
  });

  test('is reproducible: identical inputs produce identical output', async () => {
    const args = {
      patient: { _id: 'p1' },
      firstConsultation: { _id: 'c1' },
      calorieStrategy: { calorieBudget: 1800 },
      macroStrategy: { proteinPercent: 30, carbsPercent: 40, fatPercent: 30 },
      recipesByServingTime: basicPoolByServingTime(),
      weekNumbers: [1, 2],
    };
    const [first, second] = await Promise.all([
      generateDietPlanDeterministically(args),
      generateDietPlanDeterministically(args),
    ]);
    expect(first).toBe(second);
  });

  describe('regression gate: engine output independently passes utils/dietPlanValidator.js', () => {
    test.each([
      ['vegetarian, calorie-matched pool', basicPoolByServingTime(), false],
      [
        'mixed veg/non-veg pool with restrictNonVegToDayGroups',
        (() => {
          const pool = basicPoolByServingTime();
          pool.Lunch = [
            recipe('Lunch-veg', { servingTime: 'Lunch', calories: 500 }),
            recipe('Lunch-nonveg', { servingTime: 'Lunch', calories: 500, dietaryHabits: { nonVegetarian: true } }),
          ];
          pool.Dinner = [
            recipe('Dinner-veg', { servingTime: 'Dinner', calories: 500 }),
            recipe('Dinner-nonveg', { servingTime: 'Dinner', calories: 500, dietaryHabits: { nonVegetarian: true } }),
          ];
          return pool;
        })(),
        true,
      ],
    ])('%s', async (_label, pool, restrictNonVeg) => {
      const calorieStrategy = { calorieBudget: 2100, name: 'Steady' };
      const flatRecipePool = Object.values(pool).flat();

      const text = await generateDietPlanDeterministically({
        patient: { _id: 'p1' },
        firstConsultation: { _id: 'c1' },
        calorieStrategy,
        macroStrategy: { proteinPercent: 30, carbsPercent: 40, fatPercent: 30 },
        recipesByServingTime: pool,
        weekNumbers: [1, 2, 3, 4],
        restrictNonVegToDayGroups: restrictNonVeg,
      });

      const result = validateDietPlan({
        parsedPlan: JSON.parse(text),
        recipePool: flatRecipePool,
        calorieStrategy,
        weightTrend: 'gain',
        restrictNonVegToDayGroups: restrictNonVeg,
      });

      expect(result.hasSevereIssues).toBe(false);
    });
  });
});
