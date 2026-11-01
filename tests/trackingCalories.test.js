/**
 * The calorie chart is one item per day of the clamped range, whatever its
 * width; every logged day is counted exactly once. Weight and BMI keep their
 * own (daily, weekly or monthly) buckets. Meal logs sit at UTC midnight, like
 * MealLog.date in production.
 */
const { connectTestDb, disconnectTestDb, clearTestDb } = require('./helpers/testDb');
const { createTwoCyclePatient, addCycleMeals, plannedKcalFor, utcDay, dayKey } = require('./helpers/twoCycleFixture');

jest.mock('../utils/supabaseAuth');
const { registerTestToken, clearTestTokens } = require('../utils/supabaseAuth');

let request, app, MealLog, DietPlan, planDayCalories;

beforeAll(async () => {
  await connectTestDb();
  request = require('supertest');
  app = require('../config/createApp')();
  ({ MealLog, DietPlan } = require('../models'));
  planDayCalories = require('../utils/planDayCalories');
});
afterEach(async () => {
  clearTestTokens();
  await clearTestDb();
});
afterAll(async () => disconnectTestDb());

// A 42 day history (the 21 Sep - 1 Nov shape): it starts on cycle 1's first day.
const HISTORY_START_OFFSET = -41;
// Logged on 41 days across both cycles, skipping two days.
const LOGGED_OFFSETS = Array.from({ length: 41 }, (_, i) => i - 40).filter(
  (o) => o !== -10 && o !== -20
);

const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

// Monday totals of the two cycles' plans (see addCycleMeals): Tuesday is 100
// lower, Wednesday 200, Thursday 300. Cycle 1 covers 28 days from its start,
// cycle 2 28 days from 6 days ago, so a 42 day history has a gap between them.
const CYCLE_1_MONDAY = 1800;
const CYCLE_2_MONDAY = 1600;

async function seed({
  historyStartOffset = HISTORY_START_OFFSET,
  loggedOffsets = LOGGED_OFFSETS,
  caloriesFor = () => 1500,
} = {}) {
  const fixture = await createTwoCyclePatient({ historyStartOffset });
  await addCycleMeals(fixture, { cycle1Monday: CYCLE_1_MONDAY, cycle2Monday: CYCLE_2_MONDAY });
  await MealLog.insertMany(
    loggedOffsets.map((offset) => ({
      patientId: fixture.patient._id,
      date: utcDay(offset),
      dayKey: dayKey(utcDay(offset)),
      meals: [{ mealType: 'Breakfast', servingTime: 'Breakfast', caloriesConsumed: caloriesFor(offset) }],
    }))
  );
  registerTestToken('patient-token', fixture.patient._id);
  registerTestToken('dietician-token', fixture.dietician._id);
  return fixture;
}

const endpoints = [
  ['patient', () => '/api/patient/tracking-data', 'patient-token'],
  ['dietician', (patient) => `/api/dietician/patients/${patient._id}/tracking-data`, 'dietician-token'],
];

describe.each(endpoints)('%s tracking-data calorie data', (_name, urlFor, token) => {
  const get = (patient, query = '') =>
    request(app).get(`${urlFor(patient)}${query}`).set('Authorization', `Bearer ${token}`);

  test('a 42 day range gives 42 daily items and the days logged add up to the logged days', async () => {
    const { patient } = await seed();
    const res = await get(patient);
    expect(res.status).toBe(200);

    const { calorieData } = res.body.data;
    expect(calorieData).toHaveLength(42);
    expect(calorieData.reduce((sum, b) => sum + b.daysLogged, 0)).toBe(LOGGED_OFFSETS.length);
    expect(res.body.data.startDate).toBe(dayKey(utcDay(HISTORY_START_OFFSET)));
    expect(res.body.data.endDate).toBe(dayKey(utcDay(0)));
  });

  test("today's log is in the last item and calorieCurrentIndex points at it", async () => {
    const { patient } = await seed();
    const { calorieData, calorieCurrentIndex } = (await get(patient)).body.data;
    const last = calorieData[calorieData.length - 1];
    expect(last.startDate).toBe(dayKey(utcDay(0)));
    expect(last.endDate).toBe(dayKey(utcDay(0)));
    expect(last.daysLogged).toBe(1);
    expect(last.calories).toBe(1500);
    expect(calorieCurrentIndex).toBe(41);
  });

  test('weight and BMI keep their weekly buckets next to the daily calories', async () => {
    const { patient } = await seed();
    const { granularity, weightTrend, bmiTrend } = (await get(patient)).body.data;
    expect(granularity).toBe('weekly');
    expect(weightTrend).toHaveLength(6);
    expect(bmiTrend).toHaveLength(6);
  });

  test('items are contiguous days that start on the history start', async () => {
    const { patient } = await seed();
    const { calorieData } = (await get(patient)).body.data;
    expect(calorieData[0].startDate).toBe(dayKey(utcDay(HISTORY_START_OFFSET)));
    calorieData.forEach((item, i) => {
      expect(item.startDate).toBe(item.endDate);
      expect(item.startDate).toBe(dayKey(utcDay(HISTORY_START_OFFSET + i)));
    });
  });

  test('a one day range gives one item', async () => {
    const { patient } = await seed();
    const today = dayKey(utcDay(0));
    const { calorieData, calorieCurrentIndex } = (await get(patient, `?startDate=${today}&endDate=${today}`)).body
      .data;
    expect(calorieData).toHaveLength(1);
    expect(calorieCurrentIndex).toBe(0);
  });

  test('a range that ends before today has no current index', async () => {
    const { patient } = await seed();
    const res = await get(patient, `?startDate=${dayKey(utcDay(-30))}&endDate=${dayKey(utcDay(-20))}`);
    expect(res.body.data.calorieData).toHaveLength(11);
    expect(res.body.data.calorieCurrentIndex).toBe(-1);
  });

  test('a start before the history start is clamped and echoed', async () => {
    const { patient } = await seed();
    const res = await get(patient, `?startDate=${dayKey(utcDay(-60))}&endDate=${dayKey(utcDay(0))}`);
    expect(res.body.data.startDate).toBe(dayKey(utcDay(HISTORY_START_OFFSET)));
    expect(res.body.data.calorieData).toHaveLength(42);
    const total = res.body.data.calorieData.reduce((sum, b) => sum + b.daysLogged, 0);
    expect(total).toBe(LOGGED_OFFSETS.length);
  });

  test('a 400 day history gives 400 items', async () => {
    const { patient } = await seed({ historyStartOffset: -399, loggedOffsets: [-1, 0] });
    const { calorieData } = (await get(patient)).body.data;
    expect(calorieData).toHaveLength(400);
    expect(calorieData.reduce((sum, b) => sum + b.daysLogged, 0)).toBe(2);
  });

  test('a 730 day history response stays under 300 KB and builds one table per plan, not per day', async () => {
    const { patient } = await seed({ historyStartOffset: -729, loggedOffsets: range(-729, 0) });
    const buildTable = jest.spyOn(planDayCalories, 'buildPlanCalorieTable');
    const { data } = (await get(patient)).body;
    expect(data.calorieData).toHaveLength(730);
    expect(JSON.stringify(data).length).toBeLessThan(300000);
    expect(buildTable).toHaveBeenCalledTimes(2);
    buildTable.mockRestore();
  });

  test("each day carries its own plan's target for that weekday, and a gap day has none", async () => {
    const { patient } = await seed();
    const { calorieData } = (await get(patient)).body.data;
    const byDay = new Map(calorieData.map((item) => [item.startDate, item]));
    const planned = (offset) => byDay.get(dayKey(utcDay(offset))).plannedCalories;

    // Cycle 1 covers offsets -41..-14, cycle 2 -6..21, the days between are a gap.
    for (const offset of [-41, -30, -20, -14]) {
      expect(planned(offset)).toBe(plannedKcalFor(CYCLE_1_MONDAY, utcDay(offset)));
    }
    for (const offset of [-6, -3, 0]) {
      expect(planned(offset)).toBe(plannedKcalFor(CYCLE_2_MONDAY, utcDay(offset)));
    }
    for (const offset of [-13, -10, -7]) expect(planned(offset)).toBe(0);
    // Different weekdays give different targets within one cycle.
    expect(new Set(calorieData.slice(0, 7).map((item) => item.plannedCalories)).size).toBeGreaterThan(1);
    calorieData.forEach((item) => expect(Number.isInteger(item.plannedCalories)).toBe(true));
  });

  test('plannedDailyCalories keeps its calorie budget value', async () => {
    const { patient, plan2 } = await seed();
    await DietPlan.updateOne({ _id: plan2._id }, { 'calorieStrategy.calorieBudget': 1750 });
    expect((await get(patient)).body.data.plannedDailyCalories).toBe(1750);
  });
});

describe('calorie streak with per-day targets', () => {
  test('a logged day with no target neither extends nor breaks the streak', async () => {
    // Within target on the last cycle 1 day, over on a gap day (no target), then within on two cycle 2 days.
    const { patient } = await seed({
      loggedOffsets: [-14, -13, -6, -5],
      caloriesFor: (offset) => (offset === -13 ? 9999 : 1000),
    });
    const res = await request(app).get('/api/patient/tracking-data').set('Authorization', 'Bearer patient-token');
    const titles = res.body.data.achievements.map((a) => a.title);
    expect(titles).toContain('Calorie champion');
  });
});
