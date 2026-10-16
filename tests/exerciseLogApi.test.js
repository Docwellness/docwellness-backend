const { connectTestDb, disconnectTestDb, clearTestDb } = require('./helpers/testDb');

jest.mock('../utils/supabaseAuth');
const { registerTestToken, clearTestTokens } = require('../utils/supabaseAuth');

let request, app, createPatient, createDietician, Exercise, ExercisePlan, resolveDayGroupForDate;

beforeAll(async () => {
  await connectTestDb();
  request = require('supertest');
  app = require('../config/createApp')();
  ({ createPatient, createDietician } = require('./helpers/factories'));
  ({ Exercise, ExercisePlan } = require('../models'));
  ({ resolveDayGroupForDate } = require('../utils/dayGroups'));
});
afterEach(async () => {
  clearTestTokens();
  await clearTestDb();
});
afterAll(async () => disconnectTestDb());

async function setup() {
  const dietician = await createDietician();
  const patient = await createPatient({ healthProfile: { bmi: 22, weightIndex: 0, weight: 68 } });
  registerTestToken('patient-token', patient._id);
  const jump = await Exercise.create({
    dieticianId: dietician._id,
    name: 'Jump Rope (Skipping)',
    category: 'Cardio',
    met: 11,
  });
  const dips = await Exercise.create({
    dieticianId: dietician._id,
    name: 'Tricep Dips (Chair)',
    category: 'Strength',
    met: 3.8,
  });
  // The plan as the dietician entered it: a flat "20 min" on both, no sets/reps,
  // on whichever rotation day group 2026-10-16 falls on.
  const dayGroup = resolveDayGroupForDate(new Date('2026-10-16'));
  await ExercisePlan.create({
    patientId: patient._id,
    dieticianId: dietician._id,
    status: 'Active',
    startDate: new Date('2026-09-21'),
    dailyExercises: [
      { exerciseId: jump._id, durationMinutes: 20, dayGroup },
      { exerciseId: dips._id, durationMinutes: 20, dayGroup },
    ],
  });
  return { jump, dips };
}

const log = (body) =>
  request(app).post('/api/patient/exercise-log').set('Authorization', 'Bearer patient-token').send(body);

describe('POST /api/patient/exercise-log - calorie estimation', () => {
  test('a reps-type exercise (tricep dips 3 x 12) is not treated as the plan 20 minutes', async () => {
    const { dips } = await setup();
    const res = await log({ date: '2026-10-16', exercises: [{ exerciseId: String(dips._id), sets: 3, reps: 12 }] });
    expect(res.status).toBe(200);
    const entry = res.body.data.log.exercises[0];
    expect(entry.durationMinutes).toBe(3.3);
    expect(entry.sets).toBe(3);
    expect(entry.reps).toBe(12);
    expect(entry.caloriesBurned).toBe(14); // 3.8 MET * 68 kg * 3.3 / 60
  });

  test('a duration-type exercise (jump rope) stays at the plan 20 minutes even if sets are sent', async () => {
    const { jump } = await setup();
    const res = await log({ date: '2026-10-16', exercises: [{ exerciseId: String(jump._id), sets: 3, reps: 12 }] });
    expect(res.status).toBe(200);
    const entry = res.body.data.log.exercises[0];
    expect(entry.durationMinutes).toBe(20);
    expect(entry.caloriesBurned).toBe(249); // 11 MET * 68 kg * 20 / 60
  });

  test('explicit minutes from the app are honoured for a duration-type exercise', async () => {
    const { jump } = await setup();
    const res = await log({ date: '2026-10-16', exercises: [{ exerciseId: String(jump._id), durationMinutes: 6 }] });
    expect(res.body.data.log.exercises[0].caloriesBurned).toBe(75); // 11 * 68 * 6 / 60
  });

  test('more sets and reps than the default burn proportionally more', async () => {
    const { dips } = await setup();
    const res = await log({ date: '2026-10-16', exercises: [{ exerciseId: String(dips._id), sets: 4, reps: 15 }] });
    const entry = res.body.data.log.exercises[0];
    // 60 reps * 3s = 180s + 3 rests * 45s = 135s -> 315s = 5.25 -> 5.3 min
    expect(entry.durationMinutes).toBe(5.3);
    expect(entry.caloriesBurned).toBe(Math.round(3.8 * 68 * (5.3 / 60)));
  });

  test('today-stats tells the app how each planned exercise is tracked', async () => {
    await setup();
    const res = await request(app)
      .get('/api/patient/exercise-log/today-stats?date=2026-10-16')
      .set('Authorization', 'Bearer patient-token');
    expect(res.status).toBe(200);
    const byName = Object.fromEntries(res.body.data.plannedExercises.map((e) => [e.name, e.trackingType]));
    expect(byName['Tricep Dips (Chair)']).toBe('reps');
    expect(byName['Jump Rope (Skipping)']).toBe('duration');
  });
});
