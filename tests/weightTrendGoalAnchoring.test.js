/**
 * Weight Trend chart: the planned line runs from the goal start weight to the
 * goal target on the goal end, and is re-based at each weekly-checkpoint
 * weigh-in (utils/weightTrendRebase.js). Untagged weigh-ins are measured
 * points only. See controllers/patient/progressController.js's
 * getTrackingData (the dietician endpoint shares the algorithm).
 *
 * Dates are UTC days relative to now, so this does not rot.
 */
const { connectTestDb, disconnectTestDb, clearTestDb } = require('./helpers/testDb');
const { utcDay, dayKey } = require('./helpers/twoCycleFixture');

jest.mock('../utils/supabaseAuth');
const { registerTestToken, clearTestTokens } = require('../utils/supabaseAuth');

let request, app;
let createPatient, createDietician;
let DietPlan, Progress;
let seedGoalTimeline;

beforeAll(async () => {
  await connectTestDb();
  request = require('supertest');
  app = require('../config/createApp')();
  ({ createPatient, createDietician } = require('./helpers/factories'));
  ({ DietPlan, Progress } = require('../models'));
  ({ seedGoalTimeline } = require('../utils/seedGoalTimeline'));
});

afterEach(async () => {
  clearTestTokens();
  await clearTestDb();
});

afterAll(async () => {
  await disconnectTestDb();
});

/**
 * A plan that started 10 days ago and ends in 18 days (28 days), with an
 * active goal from `startWeight` to `targetWeight`. Its Week 1 checkpoint is
 * 4 days ago (start + 6). No Progress log exists at seed time, so the goal's
 * startValue is exactly `startWeight`.
 */
async function seedPlanAndGoal({ startWeight, targetWeight }) {
  const dietician = await createDietician();
  const patient = await createPatient({
    healthProfile: { bmi: 22, weightIndex: 0, weight: startWeight, targetWeight: String(targetWeight) },
  });
  const startDate = utcDay(-10);
  const endDate = utcDay(18);
  const plan = await DietPlan.create({
    patientId: patient._id,
    dieticianId: dietician._id,
    status: 'Active',
    startDate,
    endDate,
    weekSchedule: [{ week: 1, startDate, endDate }],
  });
  const goal = await seedGoalTimeline(plan);
  registerTestToken('patient-token', patient._id);
  return { patient, plan, goal };
}

async function fetchWeightTrend() {
  const res = await request(app)
    .get(`/api/patient/tracking-data?startDate=${dayKey(utcDay(-10))}&endDate=${dayKey(utcDay(0))}`)
    .set('Authorization', 'Bearer patient-token');
  expect(res.status).toBe(200);
  return res.body.data.weightTrend;
}

const pointFor = (trend, offset) => trend.find((p) => p.date === dayKey(utcDay(offset)));

describe('GET /api/patient/tracking-data - weightTrend planned line', () => {
  test('a weight-loss goal projects downward before any log, from the goal start weight', async () => {
    const { goal } = await seedPlanAndGoal({ startWeight: 74, targetWeight: 64 });
    expect(goal.startValue).toBe(74);

    const trend = await fetchWeightTrend();
    expect(pointFor(trend, -10).weight).toBe(74);
    // 74 - 10 * 5 / 28 and 74 - 10 * 10 / 28
    expect(pointFor(trend, -5).weight).toBe(72.2);
    expect(pointFor(trend, 0).weight).toBe(70.4);
  });

  test('a weight-gain goal projects upward before any log', async () => {
    await seedPlanAndGoal({ startWeight: 58, targetWeight: 68 });
    const trend = await fetchWeightTrend();
    expect(pointFor(trend, 0).weight).toBeGreaterThan(pointFor(trend, -10).weight);
  });

  test('a checkpoint weigh-in re-bases the line from that checkpoint day', async () => {
    const { patient } = await seedPlanAndGoal({ startWeight: 74, targetWeight: 64 });
    await Progress.create({
      patientId: patient._id,
      date: utcDay(-4),
      weight: 70,
      week: 1,
      weekBasis: 'display',
    });

    const trend = await fetchWeightTrend();
    // Before the checkpoint nothing changed.
    expect(pointFor(trend, -5).weight).toBe(72.2);
    // The checkpoint day is the logged weight, then a straight line from it
    // to 64 on the goal end: 70 - 6 * 1 / 22 and 70 - 6 * 4 / 22.
    expect(pointFor(trend, -4).weight).toBe(70);
    expect(pointFor(trend, -3).weight).toBe(69.7);
    expect(pointFor(trend, 0).weight).toBe(68.9);
  });

  test('an untagged weigh-in is a measured point and does not re-base the line', async () => {
    const { patient } = await seedPlanAndGoal({ startWeight: 74, targetWeight: 64 });
    await Progress.create({ patientId: patient._id, date: utcDay(-5), weight: 70 });

    const trend = await fetchWeightTrend();
    const point = pointFor(trend, -5);
    expect(point.measuredWeight).toBe(70);
    expect(point.weight).toBe(72.2);
    expect(pointFor(trend, 0).weight).toBe(70.4);
  });

  test('a weigh-in entered before its checkpoint plots on the day it was entered and re-bases there', async () => {
    const { patient } = await seedPlanAndGoal({ startWeight: 74, targetWeight: 64 });
    // Week 2's checkpoint is 3 days from now; this one is entered yesterday.
    await Progress.create({
      patientId: patient._id,
      date: utcDay(-1),
      weight: 69,
      week: 2,
      weekBasis: 'display',
    });

    const trend = await fetchWeightTrend();
    expect(pointFor(trend, -1).weight).toBe(69);
    expect(pointFor(trend, -1).measuredWeight).toBe(69);
    expect(pointFor(trend, -2).weight).toBeGreaterThan(69);
  });
});
