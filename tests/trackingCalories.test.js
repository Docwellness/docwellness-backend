/**
 * Calorie buckets of the tracking-data endpoints cover every logged day of
 * the clamped range exactly once and report the days they cover. Meal logs
 * sit at UTC midnight, like MealLog.date in production.
 */
const { connectTestDb, disconnectTestDb, clearTestDb } = require('./helpers/testDb');
const { createTwoCyclePatient, utcDay, dayKey } = require('./helpers/twoCycleFixture');

jest.mock('../utils/supabaseAuth');
const { registerTestToken, clearTestTokens } = require('../utils/supabaseAuth');

let request, app, MealLog;

beforeAll(async () => {
  await connectTestDb();
  request = require('supertest');
  app = require('../config/createApp')();
  ({ MealLog } = require('../models'));
});
afterEach(async () => {
  clearTestTokens();
  await clearTestDb();
});
afterAll(async () => disconnectTestDb());

// History starts on cycle 1's first day (today - 34).
const HISTORY_START_OFFSET = -34;
// Logged on 41 days spread over both cycles, skipping two days.
const LOGGED_OFFSETS = Array.from({ length: 41 }, (_, i) => i - 40).filter(
  (o) => o !== -10 && o !== -20
);

async function seed() {
  const fixture = await createTwoCyclePatient();
  await MealLog.insertMany(
    LOGGED_OFFSETS.map((offset) => ({
      patientId: fixture.patient._id,
      date: utcDay(offset),
      dayKey: dayKey(utcDay(offset)),
      meals: [{ mealType: 'Breakfast', servingTime: 'Breakfast', caloriesConsumed: 1500 }],
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

describe.each(endpoints)('%s tracking-data calorie buckets', (_name, urlFor, token) => {
  const get = (patient, query = '') =>
    request(app).get(`${urlFor(patient)}${query}`).set('Authorization', `Bearer ${token}`);

  test('the days logged of all buckets add up to the logged days inside the range', async () => {
    const { patient } = await seed();
    const res = await get(patient);
    expect(res.status).toBe(200);

    const expected = LOGGED_OFFSETS.filter((o) => o >= HISTORY_START_OFFSET).length;
    const total = res.body.data.calorieData.reduce((sum, b) => sum + b.daysLogged, 0);
    expect(total).toBe(expected);
    expect(res.body.data.startDate).toBe(dayKey(utcDay(HISTORY_START_OFFSET)));
    expect(res.body.data.endDate).toBe(dayKey(utcDay(0)));
  });

  test("today's log is in the last bucket, whose range ends today", async () => {
    const { patient } = await seed();
    const { calorieData } = (await get(patient)).body.data;
    const last = calorieData[calorieData.length - 1];
    expect(last.endDate).toBe(dayKey(utcDay(0)));
    expect(last.daysLogged).toBeGreaterThanOrEqual(1);
    expect(last.calories).toBe(1500);
  });

  test('buckets are contiguous and carry their first and last day', async () => {
    const { patient } = await seed();
    const { calorieData } = (await get(patient)).body.data;
    expect(calorieData[0].startDate).toBe(dayKey(utcDay(HISTORY_START_OFFSET)));
    for (let i = 1; i < calorieData.length; i += 1) {
      const previousEnd = new Date(`${calorieData[i - 1].endDate}T00:00:00.000Z`);
      expect(calorieData[i].startDate).toBe(dayKey(new Date(previousEnd.getTime() + 86400000)));
    }
  });

  test('a start before the history start is clamped and echoed', async () => {
    const { patient } = await seed();
    const res = await get(patient, `?startDate=${dayKey(utcDay(-40))}&endDate=${dayKey(utcDay(0))}`);
    expect(res.body.data.startDate).toBe(dayKey(utcDay(HISTORY_START_OFFSET)));
    const total = res.body.data.calorieData.reduce((sum, b) => sum + b.daysLogged, 0);
    expect(total).toBe(LOGGED_OFFSETS.filter((o) => o >= HISTORY_START_OFFSET).length);
  });
});
