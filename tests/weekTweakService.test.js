/**
 * services/weekTweakService.js - unsaved (but real, schema-cast) DietPlan
 * documents are enough here, no DB connection needed: these functions only
 * touch dietPlan.days/weekTweaks in memory.
 */

const { connectTestDb, disconnectTestDb } = require('./helpers/testDb');

let mongoose;
let DietPlan;
let getWeekTweak;
let setWeekTweak;
let applyWeekTweak;

beforeAll(async () => {
  await connectTestDb();
  mongoose = require('mongoose');
  ({ DietPlan } = require('../models'));
  ({ getWeekTweak, setWeekTweak, applyWeekTweak } = require('../services/weekTweakService'));
});

afterAll(async () => {
  await disconnectTestDb();
});

function buildPlan() {
  const recipeId = new mongoose.Types.ObjectId();
  return new DietPlan({
    patientId: new mongoose.Types.ObjectId(),
    dieticianId: new mongoose.Types.ObjectId(),
    days: [
      {
        week: 1,
        dayGroup: 'Monday',
        meals: [
          {
            servingTime: 'Lunch',
            items: [
              { recipeId, servingMultiplier: 2, locked: false },
              { recipeId, servingMultiplier: 1, locked: true },
            ],
          },
          {
            servingTime: 'Dinner',
            items: [{ recipeId, servingMultiplier: 1, locked: false }],
          },
        ],
      },
      {
        week: 2,
        dayGroup: 'Monday',
        meals: [{ servingTime: 'Lunch', items: [{ recipeId, servingMultiplier: 1, locked: false }] }],
      },
    ],
  });
}

describe('getWeekTweak / setWeekTweak', () => {
  test('defaults to 1 when unset', () => {
    const plan = buildPlan();
    expect(getWeekTweak(plan, 'Lunch')).toBe(1);
  });

  test('setWeekTweak stores and getWeekTweak reads it back', () => {
    const plan = buildPlan();
    setWeekTweak(plan, 'Lunch', 1.25);
    expect(getWeekTweak(plan, 'Lunch')).toBe(1.25);
    expect(getWeekTweak(plan, 'Dinner')).toBe(1); // untouched
  });
});

describe('applyWeekTweak', () => {
  test('scales every unlocked item in the slot for the given week only', () => {
    const plan = buildPlan();
    const changed = applyWeekTweak({ dietPlan: plan, week: 1, servingTime: 'Lunch', multiplier: 1.25 });

    expect(changed).toHaveLength(1); // only the unlocked Lunch item in week 1
    const week1Lunch = plan.days[0].meals[0].items;
    expect(week1Lunch[0].servingMultiplier).toBeCloseTo(2.5); // 2 * 1.25
    expect(week1Lunch[1].servingMultiplier).toBe(1); // locked - untouched

    const week1Dinner = plan.days[0].meals[1].items[0];
    expect(week1Dinner.servingMultiplier).toBe(1); // different slot - untouched

    const week2Lunch = plan.days[1].meals[0].items[0];
    expect(week2Lunch.servingMultiplier).toBe(1); // different week - untouched

    expect(getWeekTweak(plan, 'Lunch')).toBe(1.25);
  });

  test('is idempotent when the same multiplier is set twice', () => {
    const plan = buildPlan();
    applyWeekTweak({ dietPlan: plan, week: 1, servingTime: 'Lunch', multiplier: 1.25 });
    applyWeekTweak({ dietPlan: plan, week: 1, servingTime: 'Lunch', multiplier: 1.25 });
    expect(plan.days[0].meals[0].items[0].servingMultiplier).toBeCloseTo(2.5);
  });

  test('re-applying a different multiplier corrects from the OLD tweak, not compounding', () => {
    const plan = buildPlan();
    applyWeekTweak({ dietPlan: plan, week: 1, servingTime: 'Lunch', multiplier: 1.25 }); // 2 -> 2.5
    applyWeekTweak({ dietPlan: plan, week: 1, servingTime: 'Lunch', multiplier: 0.75 }); // back down from 1.25x to 0.75x baseline
    // 2.5 / 1.25 * 0.75 = 1.5, i.e. the ORIGINAL base (2) * 0.75, not 2.5*0.75.
    expect(plan.days[0].meals[0].items[0].servingMultiplier).toBeCloseTo(1.5);
  });

  test('throws for a non-positive multiplier', () => {
    const plan = buildPlan();
    expect(() => applyWeekTweak({ dietPlan: plan, week: 1, servingTime: 'Lunch', multiplier: 0 })).toThrow();
    expect(() => applyWeekTweak({ dietPlan: plan, week: 1, servingTime: 'Lunch', multiplier: -1 })).toThrow();
  });
});
