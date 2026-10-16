const mongoose = require('mongoose');
const { connectTestDb, disconnectTestDb, clearTestDb } = require('./helpers/testDb');

let ExerciseLog, ExercisePlan, backfillInflatedExerciseLogs;

beforeAll(async () => {
  await connectTestDb();
  ({ ExerciseLog, ExercisePlan } = require('../models'));
  ({ backfillInflatedExerciseLogs } = require('../utils/backfillInflatedExerciseLogs'));
});
afterEach(async () => clearTestDb());
afterAll(async () => disconnectTestDb());

const id = () => new mongoose.Types.ObjectId();

async function seed({ planSets, loggedSets, loggedMinutes, calories }) {
  const patientId = id();
  const exerciseId = id();
  await ExercisePlan.collection.insertOne({
    patientId,
    dieticianId: id(),
    status: 'Active',
    startDate: new Date('2026-09-21'),
    dailyExercises: [
      { exerciseId, durationMinutes: 20, sets: planSets, reps: null, dayGroup: 'Monday' },
    ],
  });
  await ExerciseLog.collection.insertOne({
    patientId,
    date: new Date('2026-10-16'),
    exercises: [
      {
        exerciseId,
        durationMinutes: loggedMinutes,
        sets: loggedSets,
        reps: 12,
        caloriesBurned: calories,
      },
    ],
    totalCaloriesBurned: calories,
  });
  return { patientId };
}

describe('backfillInflatedExerciseLogs', () => {
  test('dry run reports the inflated 60-minute / 748 kcal entry but changes nothing', async () => {
    await seed({ planSets: null, loggedSets: 3, loggedMinutes: 60, calories: 748 });
    const result = await backfillInflatedExerciseLogs();
    expect(result.entriesAffected).toBe(1);
    expect(result.changes[0]).toMatchObject({ durationFrom: 60, durationTo: 20, caloriesFrom: 748, caloriesTo: 249 });
    const log = await ExerciseLog.findOne();
    expect(log.exercises[0].durationMinutes).toBe(60);
    expect(log.totalCaloriesBurned).toBe(748);
  });

  test('apply corrects duration, calories and the day total', async () => {
    await seed({ planSets: null, loggedSets: 3, loggedMinutes: 60, calories: 748 });
    const result = await backfillInflatedExerciseLogs({ apply: true });
    expect(result.logsTouched).toBe(1);
    const log = await ExerciseLog.findOne();
    expect(log.exercises[0].durationMinutes).toBe(20);
    expect(log.exercises[0].caloriesBurned).toBe(249);
    expect(log.totalCaloriesBurned).toBe(249);
  });

  test('leaves a genuine per-set plan (plan has sets) alone', async () => {
    await seed({ planSets: 3, loggedSets: 3, loggedMinutes: 60, calories: 748 });
    const result = await backfillInflatedExerciseLogs({ apply: true });
    expect(result.entriesAffected).toBe(0);
    expect((await ExerciseLog.findOne()).exercises[0].durationMinutes).toBe(60);
  });

  test('leaves entries whose duration is not the plan duration times sets', async () => {
    await seed({ planSets: null, loggedSets: 3, loggedMinutes: 45, calories: 561 });
    const result = await backfillInflatedExerciseLogs({ apply: true });
    expect(result.entriesAffected).toBe(0);
  });
});
