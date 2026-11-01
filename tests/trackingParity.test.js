/**
 * The patient app and the dietician app must read the same planned weights,
 * measured weights and calorie buckets for the same patient and range
 * (both go through utils/weightTrendRebase.js and utils/trackingBuckets.js).
 */
const { connectTestDb, disconnectTestDb, clearTestDb } = require('./helpers/testDb');
const { createTwoCyclePatient, utcDay, dayKey } = require('./helpers/twoCycleFixture');

jest.mock('../utils/supabaseAuth');
const { registerTestToken, clearTestTokens } = require('../utils/supabaseAuth');

let request, app, Progress, MealLog, DietPlan;

beforeAll(async () => {
  await connectTestDb();
  request = require('supertest');
  app = require('../config/createApp')();
  ({ Progress, MealLog, DietPlan } = require('../models'));
});
afterEach(async () => {
  clearTestTokens();
  await clearTestDb();
});
afterAll(async () => disconnectTestDb());

// A renewal fixture: Weeks 1 and 4 weighed in (72 and 64 kg), meals logged on
// the last two weeks, and a calorie budget on the cycle 2 plan.
async function seed() {
  const fixture = await createTwoCyclePatient();
  const { patient, dietician, plan2 } = fixture;
  await Progress.create({ patientId: patient._id, date: utcDay(-28), weight: 72, week: 1, weekBasis: 'display' });
  await Progress.create({ patientId: patient._id, date: utcDay(-7), weight: 64, week: 4, weekBasis: 'display' });
  await MealLog.insertMany(
    [-9, -8, -3, -2, 0].map((offset) => ({
      patientId: patient._id,
      date: utcDay(offset),
      dayKey: dayKey(utcDay(offset)),
      meals: [{ mealType: 'Breakfast', servingTime: 'Breakfast', caloriesConsumed: 1200 + offset }],
    }))
  );
  await DietPlan.updateOne({ _id: plan2._id }, { 'calorieStrategy.calorieBudget': 1800 });
  registerTestToken('patient-token', patient._id);
  registerTestToken('dietician-token', dietician._id);
  return fixture;
}

const patientData = async (query = '') =>
  (await request(app).get(`/api/patient/tracking-data${query}`).set('Authorization', 'Bearer patient-token')).body.data;
const dieticianData = async (patient, query = '') =>
  (
    await request(app)
      .get(`/api/dietician/patients/${patient._id}/tracking-data${query}`)
      .set('Authorization', 'Bearer dietician-token')
  ).body.data;

describe('patient and dietician tracking-data parity', () => {
  test.each([
    ['the default range', ''],
    ['a 10 day range', `?startDate=${dayKey(utcDay(-9))}&endDate=${dayKey(utcDay(0))}`],
  ])('give the same trend, calories and planned calories for %s', async (_label, query) => {
    const { patient } = await seed();
    const forPatient = await patientData(query);
    const forDietician = await dieticianData(patient, query);

    expect(forPatient.weightTrend.length).toBeGreaterThan(0);
    expect(forDietician.weightTrend).toEqual(forPatient.weightTrend);
    expect(forDietician.calorieData).toEqual(forPatient.calorieData);
    expect(forDietician.plannedDailyCalories).toBe(1800);
    expect(forPatient.plannedDailyCalories).toBe(1800);
  });

  test('after a renewal the planned weight on the Week 4 weigh-in day is the logged 64 kg', async () => {
    const { patient } = await seed();
    for (const data of [await patientData(), await dieticianData(patient)]) {
      const point = data.weightTrend.find((p) => p.date === dayKey(utcDay(-7)));
      expect(point.weight).toBe(64);
      expect(point.measuredWeight).toBe(64);
    }
  });

  test('a pause moves the goal end, and so the planned line, the same way in both apps', async () => {
    const { patient, plan2 } = await seed();
    const todayPoint = (data) => data.weightTrend[data.weightTrend.length - 1];

    // Goal end is today + 21: 7 of 28 days from the Week 4 weigh-in, 64 -> 60.
    expect(todayPoint(await patientData()).weight).toBe(63);

    await DietPlan.updateOne(
      { _id: plan2._id },
      { pauses: [{ startDate: utcDay(-3), resumeDate: utcDay(-1) }] }
    );
    // Two paused days: the end moves to today + 23, so 7 of 30 days.
    const paused = todayPoint(await patientData());
    expect(paused.weight).toBe(63.1);
    expect(todayPoint(await dieticianData(patient)).weight).toBe(63.1);
  });
});
