const mongoose = require('mongoose');
const { connectTestDb, disconnectTestDb, clearTestDb } = require('./helpers/testDb');

let Exercise, ExerciseLog, backfillRepsExerciseLogs;

beforeAll(async () => {
  await connectTestDb();
  ({ Exercise, ExerciseLog } = require('../models'));
  ({ backfillRepsExerciseLogs } = require('../utils/backfillRepsExerciseLogs'));
});
afterEach(async () => clearTestDb());
afterAll(async () => disconnectTestDb());

const id = () => new mongoose.Types.ObjectId();

async function seed({ name, category, met, entry }) {
  const ex = await Exercise.create({ dieticianId: id(), name, category, met });
  await ExerciseLog.collection.insertOne({
    patientId: id(),
    date: new Date('2026-10-14'),
    exercises: [{ exerciseId: ex._id, ...entry }],
    totalCaloriesBurned: entry.caloriesBurned,
  });
  return ex;
}

describe('backfillRepsExerciseLogs', () => {
  test('dry run reports a 3 x 12 dips entry logged as 20 minutes, changes nothing', async () => {
    await seed({
      name: 'Tricep Dips (Chair)',
      category: 'Strength',
      met: 3.8,
      entry: { durationMinutes: 20, sets: 3, reps: 12, caloriesBurned: 86 }, // 3.8 * 68 * 20/60
    });
    const result = await backfillRepsExerciseLogs();
    expect(result.entriesAffected).toBe(1);
    expect(result.changes[0]).toMatchObject({ durationFrom: 20, durationTo: 3.3, caloriesFrom: 86, caloriesTo: 14 });
    expect((await ExerciseLog.findOne()).exercises[0].durationMinutes).toBe(20);
  });

  test('apply corrects duration, calories and the day total, and a second run finds nothing', async () => {
    await seed({
      name: 'Tricep Dips (Chair)',
      category: 'Strength',
      met: 3.8,
      entry: { durationMinutes: 20, sets: 3, reps: 12, caloriesBurned: 86 },
    });
    const first = await backfillRepsExerciseLogs({ apply: true });
    expect(first.logsTouched).toBe(1);
    const log = await ExerciseLog.findOne();
    expect(log.exercises[0].durationMinutes).toBe(3.3);
    expect(log.exercises[0].caloriesBurned).toBe(14);
    expect(log.totalCaloriesBurned).toBe(14);
    const second = await backfillRepsExerciseLogs({ apply: true });
    expect(second.entriesAffected).toBe(0);
  });

  test('leaves a duration-type exercise (jump rope) alone', async () => {
    await seed({
      name: 'Jump Rope (Skipping)',
      category: 'Cardio',
      met: 11,
      entry: { durationMinutes: 20, sets: 3, reps: 12, caloriesBurned: 249 },
    });
    expect((await backfillRepsExerciseLogs({ apply: true })).entriesAffected).toBe(0);
  });

  test('leaves a reps-type entry that has no sets/reps (nothing to derive from)', async () => {
    await seed({
      name: 'Push-Ups',
      category: 'Strength',
      met: 3.8,
      entry: { durationMinutes: 20, sets: null, reps: null, caloriesBurned: 86 },
    });
    expect((await backfillRepsExerciseLogs({ apply: true })).entriesAffected).toBe(0);
  });
});
