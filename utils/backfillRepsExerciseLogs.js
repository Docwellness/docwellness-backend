const { ExerciseLog, Exercise } = require('../models');
const { resolveTrackingType, resolveSecondsPerRep } = require('./exerciseTracking');
const { estimateRepsDurationMinutes } = require('./exerciseHelpers');

/**
 * Re-estimates past logs of reps-type exercises (push-ups, squats, tricep
 * dips, crunches...) that were stored with the generic plan block (e.g. "20
 * min") instead of the time the sets x reps actually take.
 *
 * Only entries that carry both `sets` and `reps` are touched - those are the
 * numbers the patient logged, so the new duration is derived from them
 * (utils/exerciseHelpers.js's estimateRepsDurationMinutes: movement time plus
 * rest between sets). Calories are scaled by newDuration / oldDuration, which
 * keeps whatever body weight was used when the entry was first logged.
 * Duration-type exercises (jump rope, plank...) and entries without sets/reps
 * are left alone.
 *
 * `apply: false` (default) only reports what would change. Idempotent.
 */
async function backfillRepsExerciseLogs({ apply = false } = {}) {
  const exercises = await Exercise.find({}).select('name category trackingType secondsPerRep').lean();
  const exerciseById = new Map(exercises.map((e) => [String(e._id), e]));

  const changes = [];
  let logsTouched = 0;
  const cursor = ExerciseLog.find({}).cursor();
  for await (const log of cursor) {
    let touched = false;
    for (const entry of log.exercises) {
      const ex = exerciseById.get(String(entry.exerciseId));
      if (!ex || resolveTrackingType(ex) !== 'reps') continue;
      if (!(typeof entry.sets === 'number' && entry.sets > 0)) continue;
      if (!(typeof entry.reps === 'number' && entry.reps > 0)) continue;
      if (!(typeof entry.durationMinutes === 'number' && entry.durationMinutes > 0)) continue;

      const estimated = estimateRepsDurationMinutes({
        sets: entry.sets,
        reps: entry.reps,
        secondsPerRep: resolveSecondsPerRep(ex),
      });
      const newDuration = Math.max(0.5, Math.round(estimated * 10) / 10);
      if (Math.abs(newDuration - entry.durationMinutes) < 0.05) continue; // already right

      const newCalories = Math.round((entry.caloriesBurned || 0) * (newDuration / entry.durationMinutes));
      changes.push({
        logId: String(log._id),
        patientId: String(log.patientId),
        exercise: ex.name,
        date: log.date,
        sets: entry.sets,
        reps: entry.reps,
        durationFrom: entry.durationMinutes,
        durationTo: newDuration,
        caloriesFrom: entry.caloriesBurned,
        caloriesTo: newCalories,
      });
      if (apply) {
        entry.durationMinutes = newDuration;
        entry.caloriesBurned = newCalories;
        touched = true;
      }
    }
    if (touched) {
      log.totalCaloriesBurned = Math.round(
        log.exercises.reduce((sum, e) => sum + (e.caloriesBurned || 0), 0)
      );
      await log.save();
      logsTouched += 1;
    }
  }
  return { apply, entriesAffected: changes.length, logsTouched, changes };
}

module.exports = { backfillRepsExerciseLogs };
