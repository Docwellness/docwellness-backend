/**
 * Round-trip tests for utils/dietPlanLegacyView.js (Phase 1c/1d) - the shim
 * that converts between the legacy finalizedPlan/draftPlan
 * `{weeks:[{week,dailyMeals}]}` blob shape and the typed `days[]`
 * subdocument schema (models/DietPlan.js).
 */

const {
  getFinalizedWeeks,
  getDraftWeeks,
  applyLegacyWeekPayload,
  buildLegacyWeeksView,
  daysFromLegacyWeekPayload,
} = require('../utils/dietPlanLegacyView');

describe('getFinalizedWeeks / getDraftWeeks', () => {
  test('return [] for a plan with no finalizedPlan/draftPlan yet', () => {
    expect(getFinalizedWeeks({})).toEqual([]);
    expect(getDraftWeeks({})).toEqual([]);
    expect(getFinalizedWeeks(null)).toEqual([]);
  });

  test('read the legacy blob unchanged', () => {
    const weeks = [{ week: 1, dailyMeals: [] }];
    expect(getFinalizedWeeks({ finalizedPlan: { weeks } })).toBe(weeks);
    expect(getDraftWeeks({ draftPlan: { weeks } })).toBe(weeks);
  });
});

describe('daysFromLegacyWeekPayload', () => {
  test('groups dailyMeals by dayGroup then servingTime', () => {
    const days = daysFromLegacyWeekPayload({
      week: 1,
      dailyMeals: [
        { dayGroup: 'Monday', servingTime: 'Breakfast', recipeId: 'r1', servings: 2 },
        { dayGroup: 'Monday', servingTime: 'Lunch', recipeId: 'r2', servings: 1 },
        { dayGroup: 'Monday', servingTime: 'Lunch', recipeId: 'r3', servings: 1 }, // side dish, same slot
        { dayGroup: 'Tuesday', servingTime: 'Breakfast', recipeId: 'r1', servings: 3 },
      ],
    });

    expect(days).toHaveLength(2);
    const monday = days.find((d) => d.dayGroup === 'Monday');
    expect(monday.week).toBe(1);
    expect(monday.meals.find((m) => m.servingTime === 'Breakfast').items).toEqual([
      expect.objectContaining({ recipeId: 'r1', servingMultiplier: 2 }),
    ]);
    expect(monday.meals.find((m) => m.servingTime === 'Lunch').items).toHaveLength(2);

    const tuesday = days.find((d) => d.dayGroup === 'Tuesday');
    expect(tuesday.meals).toHaveLength(1);
    expect(tuesday.meals[0].items[0]).toEqual(
      expect.objectContaining({ recipeId: 'r1', servingMultiplier: 3 })
    );
  });

  test('maps secondaryServings into a 2-element componentServings array', () => {
    const days = daysFromLegacyWeekPayload({
      week: 1,
      dailyMeals: [
        { dayGroup: 'Monday', servingTime: 'Breakfast', recipeId: 'r1', servings: 2, secondaryServings: 1 },
      ],
    });
    expect(days[0].meals[0].items[0].componentServings).toEqual([2, 1]);
  });

  test('passes componentServings through directly when present', () => {
    const days = daysFromLegacyWeekPayload({
      week: 1,
      dailyMeals: [
        { dayGroup: 'Monday', servingTime: 'Breakfast', recipeId: 'r1', servings: 1, componentServings: [3, 1, 2] },
      ],
    });
    expect(days[0].meals[0].items[0].componentServings).toEqual([3, 1, 2]);
  });

  test('drops entries with an invalid dayGroup or missing recipeId', () => {
    const days = daysFromLegacyWeekPayload({
      week: 1,
      dailyMeals: [
        { dayGroup: 'NotADay', servingTime: 'Breakfast', recipeId: 'r1', servings: 1 },
        { dayGroup: 'Monday', servingTime: 'Breakfast', servings: 1 }, // no recipeId
      ],
    });
    expect(days).toEqual([]);
  });

  test('every produced supplements[] array is empty (supplements are not part of dailyMeals today)', () => {
    const days = daysFromLegacyWeekPayload({
      week: 1,
      dailyMeals: [{ dayGroup: 'Monday', servingTime: 'Breakfast', recipeId: 'r1', servings: 1 }],
    });
    expect(days[0].meals[0].supplements).toEqual([]);
  });
});

describe('applyLegacyWeekPayload + buildLegacyWeeksView round trip', () => {
  // A plain object with markModified stubbed is enough here - these
  // functions only touch dietPlan.days and call markModified, they don't
  // need a real Mongoose document or a DB connection.
  function fakeDietPlan(initial = {}) {
    return { days: [], markModified: jest.fn(), ...initial };
  }

  test('round-trips a single week exactly (as an order-independent set)', () => {
    const plan = fakeDietPlan();
    const weekPayload = {
      week: 1,
      dailyMeals: [
        { dayGroup: 'Monday', servingTime: 'Breakfast', recipeId: 'r1', servings: 2 },
        { dayGroup: 'Monday', servingTime: 'Lunch', recipeId: 'r2', servings: 1 },
        { dayGroup: 'Wednesday', servingTime: 'Dinner', recipeId: 'r3', servings: 4 },
      ],
    };

    applyLegacyWeekPayload(plan, weekPayload);
    expect(plan.markModified).toHaveBeenCalledWith('days');

    const derived = buildLegacyWeeksView(plan);
    expect(derived.weeks).toHaveLength(1);
    expect(derived.weeks[0].week).toBe(1);
    expect(derived.weeks[0].dailyMeals).toEqual(
      expect.arrayContaining(weekPayload.dailyMeals.map((m) => expect.objectContaining(m)))
    );
    expect(derived.weeks[0].dailyMeals).toHaveLength(3);
  });

  test('re-applying the same week fully replaces it, not appends', () => {
    const plan = fakeDietPlan();
    applyLegacyWeekPayload(plan, {
      week: 1,
      dailyMeals: [{ dayGroup: 'Monday', servingTime: 'Breakfast', recipeId: 'r1', servings: 1 }],
    });
    applyLegacyWeekPayload(plan, {
      week: 1,
      dailyMeals: [{ dayGroup: 'Monday', servingTime: 'Breakfast', recipeId: 'r2', servings: 1 }],
    });

    const derived = buildLegacyWeeksView(plan);
    expect(derived.weeks).toHaveLength(1);
    expect(derived.weeks[0].dailyMeals).toEqual([
      expect.objectContaining({ recipeId: 'r2' }),
    ]);
  });

  test('applying a second week leaves the first week untouched', () => {
    const plan = fakeDietPlan();
    applyLegacyWeekPayload(plan, {
      week: 1,
      dailyMeals: [{ dayGroup: 'Monday', servingTime: 'Breakfast', recipeId: 'r1', servings: 1 }],
    });
    applyLegacyWeekPayload(plan, {
      week: 2,
      dailyMeals: [{ dayGroup: 'Monday', servingTime: 'Breakfast', recipeId: 'r2', servings: 1 }],
    });

    const derived = buildLegacyWeeksView(plan);
    expect(derived.weeks.map((w) => w.week)).toEqual([1, 2]);
  });

  test('an empty plan produces an empty weeks array', () => {
    expect(buildLegacyWeeksView(fakeDietPlan())).toEqual({ weeks: [] });
    expect(buildLegacyWeeksView({})).toEqual({ weeks: [] });
  });
});
