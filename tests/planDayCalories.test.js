/**
 * The calorie target of one day of a plan (utils/planDayCalories.js): the same
 * number Home calls totalPlannedCalories, looked up from a per-plan table.
 * The pure section builds every date with Date.UTC and never reads a local
 * getter, so it passes on any host timezone; the DB section checks the table
 * against Home (computeDailyMealLogSummary) for both plan models.
 */
const { connectTestDb, disconnectTestDb, clearTestDb } = require('./helpers/testDb');
const {
  buildPlannedRecipeIndex,
  plannedMealCalories,
  planCoverage,
  calorieTargetForDay,
  loadDailyCalorieTargets,
} = require('../utils/planDayCalories');

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const utc = (y, m, d) => new Date(Date.UTC(y, m - 1, d));
const key = (date) => date.toISOString().slice(0, 10);

describe('plannedMealCalories', () => {
  const recipeDocs = [
    {
      _id: 'r1',
      nutrition: { calories: 400 },
      components: [
        { label: 'Rice', quantity: 100, unit: 'g' },
        { label: 'Dal', quantity: 50, unit: 'g' },
      ],
    },
  ];

  test('an older plan meal scales by the ratio of its component servings', () => {
    const recipes = buildPlannedRecipeIndex(recipeDocs);
    // Rice x2 and Dal x1: ratios 2 and 1, average 1.5.
    const meal = { recipeId: 'r1', servingTime: 'Lunch', componentServings: [200, 50] };
    expect(plannedMealCalories(meal, recipes, false)).toBe(600);
  });

  test('a plan-item meal uses the version nutrition at ratio 1', () => {
    const recipes = buildPlannedRecipeIndex(recipeDocs, {
      'r1::v2': { baseRecipeId: 'r1', nutritionPerServing: { calories: 389 } },
    });
    const meal = { recipeId: 'r1::v2', servingTime: 'Lunch', servings: 3 };
    expect(plannedMealCalories(meal, recipes, true)).toBe(389);
  });

  test('a meal whose recipe is missing contributes 0', () => {
    const recipes = buildPlannedRecipeIndex(recipeDocs);
    expect(plannedMealCalories({ recipeId: 'gone', servingTime: 'Lunch' }, recipes, false)).toBe(0);
  });
});

describe('calorieTargetForDay', () => {
  // 2026-10-05 is a Monday. Day groups: Mon/Fri, Tue/Sat, Wed/Sun, Thu.
  const MONDAY = utc(2026, 10, 5);
  const weeksFrom = (start, count) =>
    Array.from({ length: count }, (_, i) => ({
      week: i + 1,
      startDate: new Date(start.getTime() + i * 7 * MS_PER_DAY),
      endDate: new Date(start.getTime() + (i * 7 + 6) * MS_PER_DAY),
    }));
  const planFrom = (cycleNumber, start, weekCount = 2) => ({
    cycleNumber,
    weekSchedule: weeksFrom(start, weekCount),
  });
  const tableOf = (monday, weeks = 4) =>
    Object.fromEntries(
      Array.from({ length: weeks }, (_, i) => [
        i + 1,
        { Monday: monday, Tuesday: monday - 100, Wednesday: monday - 200, Thursday: monday - 300 },
      ])
    );
  const targetFor = (day, plans, tables, pauses = []) =>
    calorieTargetForDay(
      key(day),
      plans.map((plan) => planCoverage(plan, pauses)),
      new Map(tables.map((table, i) => [String(plans[i].cycleNumber), table])),
      pauses
    );
  const day = (offset) => new Date(MONDAY.getTime() + offset * MS_PER_DAY);

  const cycle1 = planFrom(1, MONDAY);

  test('the same logged calories meet a different target on Monday and Thursday', () => {
    expect(targetFor(day(0), [cycle1], [tableOf(1800)])).toBe(1800);
    expect(targetFor(day(3), [cycle1], [tableOf(1800)])).toBe(1500);
  });

  test('Friday uses the Monday group and Sunday the Wednesday group', () => {
    expect(targetFor(day(4), [cycle1], [tableOf(1800)])).toBe(1800);
    expect(targetFor(day(5), [cycle1], [tableOf(1800)])).toBe(1700);
    expect(targetFor(day(6), [cycle1], [tableOf(1800)])).toBe(1600);
  });

  test('the day before the plan starts has no target', () => {
    expect(targetFor(day(-1), [cycle1], [tableOf(1800)])).toBe(0);
  });

  test('a day after the last week end has no target', () => {
    expect(targetFor(day(13), [cycle1], [tableOf(1800)])).toBe(1600);
    expect(targetFor(day(14), [cycle1], [tableOf(1800)])).toBe(0);
  });

  test('a day in the gap between two plans has no target', () => {
    const cycle2 = planFrom(2, day(21));
    expect(targetFor(day(17), [cycle1, cycle2], [tableOf(1800), tableOf(1600)])).toBe(0);
    expect(targetFor(day(21), [cycle1, cycle2], [tableOf(1800), tableOf(1600)])).toBe(1600);
  });

  test('where cycle 1 and cycle 2 overlap the lowest cycle wins', () => {
    const cycle2 = planFrom(2, day(7));
    const tables = [tableOf(1800), tableOf(1600)];
    expect(targetFor(day(7), [cycle1, cycle2], tables)).toBe(1800); // both cover this Monday
    expect(targetFor(day(14), [cycle1, cycle2], tables)).toBe(1600); // only cycle 2
  });

  test('a paused day has no target and the day after the resume uses the shifted content day', () => {
    // Paused Mon 12 Oct and Tue 13 Oct; Wednesday the 14th serves Monday's content.
    const pauses = [{ startDate: day(7), resumeDate: day(9) }];
    const tables = [tableOf(1800)];
    expect(targetFor(day(7), [cycle1], tables, pauses)).toBe(0);
    expect(targetFor(day(8), [cycle1], tables, pauses)).toBe(0);
    expect(targetFor(day(9), [cycle1], tables, pauses)).toBe(1800);
    // The pause pushed the last week end from day 13 to day 15, a Monday's
    // worth of content later: day 15 serves day 13's content, a Sunday.
    expect(targetFor(day(15), [cycle1], tables, pauses)).toBe(1600);
    expect(targetFor(day(16), [cycle1], tables, pauses)).toBe(0);
  });

  test('a plan without a week schedule covers 28 days from its start', () => {
    const undated = { cycleNumber: 1, activationDate: MONDAY };
    expect(planCoverage(undated).endDay).toBe('2026-11-01');
    expect(targetFor(day(27), [undated], [tableOf(1800)])).toBe(1600);
    expect(targetFor(day(28), [undated], [tableOf(1800)])).toBe(0);
  });

  test('a week or group missing from the table has no target', () => {
    expect(targetFor(day(0), [cycle1], [{ 2: { Monday: 1800 } }])).toBe(0);
    expect(targetFor(day(3), [cycle1], [{ 1: { Monday: 1800 } }])).toBe(0);
  });

  test('every target is an integer', () => {
    const value = targetFor(day(0), [cycle1], [tableOf(1800.6)]);
    expect(value).toBe(1801);
    expect(Number.isInteger(value)).toBe(true);
  });
});

describe('plan calories against Home (DB)', () => {
  let createPatient;
  let createDietician;
  let Recipe;
  let RecipeVersion;
  let FoodItem;
  let DietPlan;
  let DayPlan;
  let MealSlotPlan;
  let PlanItem;
  let computeDailyMealLogSummary;
  let buildDailyBuckets;

  beforeAll(async () => {
    await connectTestDb();
    ({ createPatient, createDietician } = require('./helpers/factories'));
    ({ Recipe, RecipeVersion, FoodItem, DietPlan, DayPlan, MealSlotPlan, PlanItem } = require('../models'));
    ({ computeDailyMealLogSummary } = require('../utils/dailyMealLogSummary'));
    ({ buildDailyBuckets } = require('../utils/trackingBuckets'));
  });
  afterEach(async () => clearTestDb());
  afterAll(async () => disconnectTestDb());

  const utcDay = (offset) => {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) + offset * MS_PER_DAY);
  };
  // Four 7-day weeks, the first starting 9 days ago, so the last 7 days span weeks 1 and 2.
  const weekSchedule = Array.from({ length: 4 }, (_, i) => ({
    week: i + 1,
    startDate: utcDay(-9 + i * 7),
    endDate: utcDay(-9 + i * 7 + 6),
  }));
  const last7Days = Array.from({ length: 7 }, (_, i) => utcDay(i - 6));

  async function targetsFor(patient) {
    const buckets = buildDailyBuckets(last7Days[0], new Date(last7Days[6].getTime() + MS_PER_DAY - 1));
    return loadDailyCalorieTargets(patient._id, buckets);
  }

  async function expectTargetsToMatchHome(patient) {
    const targets = await targetsFor(patient);
    const seen = new Set();
    for (const date of last7Days) {
      const home = await computeDailyMealLogSummary(patient._id, date);
      const expected = Math.round(home.data.summary.totalPlannedCalories);
      expect(targets.get(key(date))).toBe(expected);
      seen.add(expected);
    }
    // The fixture must give the days different targets, or the parity is trivial.
    expect(seen.size).toBeGreaterThan(1);
  }

  test('an older (finalized blob) plan matches Home on each of 7 days, with a no-dayGroup meal in every group', async () => {
    const dietician = await createDietician();
    const patient = await createPatient();
    const makeRecipe = (name, calories) =>
      Recipe.create({
        dieticianId: dietician._id,
        name,
        servingTime: 'Lunch',
        servingSize: { quantity: 100, unit: 'g' },
        components: [{ label: name, quantity: 100, unit: 'g' }],
        nutrition: { calories, protein: 10, carbs: 10, fats: 10, fiber: 1 },
      });
    const rice = await makeRecipe('Rice', 400);
    const dal = await makeRecipe('Dal', 250);
    const meal = (recipe, dayGroup, servings, servingTime = 'Lunch') => ({
      ...(dayGroup ? { dayGroup } : {}),
      servingTime,
      recipeId: recipe._id.toString(),
      servings,
    });
    await DietPlan.create({
      patientId: patient._id,
      dieticianId: dietician._id,
      status: 'Active',
      activationDate: utcDay(-9),
      weekSchedule,
      finalizedPlan: {
        weeks: [
          {
            week: 1,
            dailyMeals: [
              meal(rice, 'Monday', 100),
              meal(rice, 'Tuesday', 150),
              meal(dal, 'Wednesday', 100, 'Dinner'),
              meal(dal, 'Thursday', 200, 'Dinner'),
              meal(dal, null, 100, 'Evening Snack'),
            ],
          },
          {
            week: 2,
            dailyMeals: [meal(rice, 'Monday', 50), meal(dal, 'Tuesday', 100, 'Dinner'), meal(dal, 'Thursday', 100)],
          },
        ],
      },
    });

    await expectTargetsToMatchHome(patient);
  });

  test('a plan-item plan matches Home on each of 7 days', async () => {
    const dietician = await createDietician();
    const patient = await createPatient();
    await FoodItem.create({
      name: 'Oats',
      normalizedName: 'oats',
      nutritionPer100g: { calories: 389, protein: 17, carbs: 66, fats: 7, fiber: 10 },
    });
    const makeVersionedRecipe = async (name, grams) => {
      const recipe = await Recipe.create({
        dieticianId: dietician._id,
        name,
        servingTime: 'Breakfast',
        servingSize: { quantity: 250, unit: 'g' },
        components: [{ label: name, quantity: grams, unit: 'g' }],
        ingredients: [{ name: 'Oats', quantity: grams, unit: 'g' }],
        nutrition: { calories: 999, protein: 1, carbs: 1, fats: 1, fiber: 1 },
      });
      // The version sync hook is async and fire-and-forget: poll for it.
      let version = null;
      for (let i = 0; i < 40 && !version; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        version = await RecipeVersion.findOne({ parentRecipeId: recipe._id, versionNumber: 1 });
      }
      if (!version) throw new Error('V1 RecipeVersion never synced for the seeded recipe');
      return version;
    };
    const small = await makeVersionedRecipe('Small Oats', 100);
    const big = await makeVersionedRecipe('Big Oats', 200);

    const plan = await DietPlan.create({
      patientId: patient._id,
      dieticianId: dietician._id,
      status: 'Active',
      dataModel: 'plan-item',
      activationDate: utcDay(-9),
      weekSchedule,
    });
    const layout = {
      Monday: [small],
      Tuesday: [big],
      Wednesday: [small, big],
      Thursday: [small],
    };
    for (const week of [1, 2]) {
      for (const [dayGroup, versions] of Object.entries(layout)) {
        const dayPlan = await DayPlan.create({ dietPlanId: plan._id, patientId: patient._id, week, dayGroup });
        // Week 2 serves only the first recipe of each day, so the weeks differ.
        const served = week === 1 ? versions : versions.slice(0, 1);
        for (const version of served) {
          const slot = await MealSlotPlan.create({
            dayPlanId: dayPlan._id,
            servingTime: version === small ? 'Breakfast' : 'Lunch',
          });
          await PlanItem.create({
            mealSlotId: slot._id,
            recipeVersionId: version._id,
            calculatedNutrition: version.nutritionPerServing,
          });
        }
      }
    }

    await expectTargetsToMatchHome(patient);
  });

  test('a patient with no plan gets 0 on every day', async () => {
    const patient = await createPatient();
    const targets = await targetsFor(patient);
    expect([...targets.values()]).toEqual(Array(7).fill(0));
  });
});
