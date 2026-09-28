/**
 * Weight Trend chart must be anchored to the patient's real Progress
 * weight logs, projected between/after them at the active goal's own
 * pace (startValue -> targetValue), and re-anchor outright to any real
 * log for that exact day - see controllers/patient/progressController.js
 * and controllers/dietician/trackingController.js's getTrackingData
 * (they share this exact algorithm - see the latter's file header
 * comment).
 *
 * Dates are computed relative to `Date.now()` rather than hardcoded, so
 * this doesn't rot the way tests/timeline.test.js's hardcoded 2026-07
 * fixture dates did once the real clock moved past them.
 */
const { connectTestDb, disconnectTestDb, clearTestDb } = require('./helpers/testDb');

jest.mock('../utils/supabaseAuth');
const { registerTestToken, clearTestTokens } = require('../utils/supabaseAuth');

let request, app;
let createPatient, createDietician;
let DietPlan, Progress;
let seedGoalTimeline;

const MS_PER_DAY = 24 * 60 * 60 * 1000;
function daysAgo(n) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return new Date(d.getTime() - n * MS_PER_DAY);
}
// Must match utils/trackingBuckets.js's localDateStr exactly (local
// calendar-date getters, not UTC) - the controller keys every trend point
// by that function, so a UTC-based ymd() here would silently look up the
// wrong day whenever the test machine's local timezone isn't UTC.
function ymd(date) {
  const d = new Date(date);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

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
 * A 10-day-old plan (so cumulativeStart = today-10) with an active goal
 * going from `startWeight` to `targetWeight` - matches seedGoalTimeline's
 * own priority order (latest Progress log at seed time, else request
 * currentWeight, else healthProfile.weight), so passing no Progress log
 * yet at seed time makes the goal's startValue exactly `startWeight`.
 */
async function seedPlanAndGoal({ startWeight, targetWeight }) {
  const dietician = await createDietician();
  const patient = await createPatient({
    healthProfile: { bmi: 22, weightIndex: 0, weight: startWeight, targetWeight: String(targetWeight) },
  });
  const startDate = daysAgo(10);
  const endDate = daysAgo(-18); // 28-day plan, matches other tests' convention
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

async function fetchWeightTrend(startDate, endDate) {
  const res = await request(app)
    .get(`/api/patient/tracking-data?startDate=${ymd(startDate)}&endDate=${ymd(endDate)}`)
    .set('Authorization', 'Bearer patient-token');
  expect(res.status).toBe(200);
  return res.body.data.weightTrend;
}

function pointFor(trend, date) {
  return trend.find((p) => p.date === ymd(date));
}

describe('GET /api/patient/tracking-data - weightTrend goal anchoring', () => {
  test('a weight-loss goal projects downward before any real log, from the goal start weight', async () => {
    const { goal } = await seedPlanAndGoal({ startWeight: 74, targetWeight: 64 });
    expect(goal.startValue).toBe(74);

    const trend = await fetchWeightTrend(daysAgo(10), daysAgo(0));
    const start = pointFor(trend, daysAgo(10));
    const midway = pointFor(trend, daysAgo(5));
    const today = pointFor(trend, daysAgo(0));

    expect(start.weight).toBeCloseTo(74, 1);
    // Loss goal - the projection must trend DOWN over time with no logs.
    expect(midway.weight).toBeLessThan(start.weight);
    expect(today.weight).toBeLessThan(midway.weight);
  });

  test('a weight-gain goal projects upward before any real log', async () => {
    const { goal } = await seedPlanAndGoal({ startWeight: 58, targetWeight: 68 });
    expect(goal.startValue).toBe(58);

    const trend = await fetchWeightTrend(daysAgo(10), daysAgo(0));
    const start = pointFor(trend, daysAgo(10));
    const today = pointFor(trend, daysAgo(0));

    // Gain goal - the projection must trend UP over time with no logs.
    expect(today.weight).toBeGreaterThan(start.weight);
  });

  test('a real Progress log always wins outright and re-anchors the projection from there', async () => {
    const { patient } = await seedPlanAndGoal({ startWeight: 74, targetWeight: 64 });

    // Patient logs a real weigh-in 5 days ago - lower than pure projection
    // would have predicted, simulating faster-than-planned progress.
    await Progress.create({ patientId: patient._id, date: daysAgo(5), weight: 70 });

    const trend = await fetchWeightTrend(daysAgo(10), daysAgo(0));
    const loggedDay = pointFor(trend, daysAgo(5));
    const dayAfterLog = pointFor(trend, daysAgo(3));
    const today = pointFor(trend, daysAgo(0));

    // The logged day snaps to the REAL value, not the calorie/goal estimate.
    expect(loggedDay.weight).toBe(70);
    // Days after the log project onward from 70 (the new anchor), still
    // trending down (loss goal) - never jumping back toward the stale
    // pre-log trajectory.
    expect(dayAfterLog.weight).toBeLessThanOrEqual(70);
    expect(today.weight).toBeLessThan(dayAfterLog.weight);
  });

  test('two real logs both win outright, with projection resuming from the later one', async () => {
    const { patient } = await seedPlanAndGoal({ startWeight: 74, targetWeight: 64 });
    await Progress.create({ patientId: patient._id, date: daysAgo(7), weight: 73 });
    await Progress.create({ patientId: patient._id, date: daysAgo(2), weight: 71 });

    const trend = await fetchWeightTrend(daysAgo(10), daysAgo(0));
    expect(pointFor(trend, daysAgo(7)).weight).toBe(73);
    expect(pointFor(trend, daysAgo(2)).weight).toBe(71);
    // Between the two real logs, the projection runs from the day-7 log
    // (73) toward the goal direction, not from the original goal start.
    const between = pointFor(trend, daysAgo(4));
    expect(between.weight).toBeLessThan(73);
  });
});
