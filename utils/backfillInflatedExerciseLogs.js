const { ExerciseLog, ExercisePlan } = require('../models');

/**
 * Corrects exercise logs inflated by the sets-multiplier bug fixed in
 * utils/exerciseHelpers.js's estimateDurationMinutes: the app's log dialog
 * always sent sets (default 3), and a flat plan duration (plan entry with a
 * duration and NO sets, e.g. "20 min jump rope") was multiplied by it - a
 * 20 minute session was stored as 60 minutes with 3x the calories.
 *
 * Signature of an affected entry: the patient has a plan entry for that
 * exercise with durationMinutes = d and sets = null, and the log entry has
 * sets > 1 with durationMinutes exactly d * sets. Such an entry is reset to d
 * minutes and its calories scaled by d / loggedDuration (so the weight that
 * was used at the time is kept). Entries from genuinely per-set plans (plan
 * sets set), or that don't match the signature, are left alone.
 *
 * `apply: false` (default) only reports what would change.
 */
async function backfillInflatedExerciseLogs({ apply = false } = {}) {
  const plans = await ExercisePlan.find({}).select('patientId dailyExercises').lean();
  // patientId|exerciseId -> Set of flat plan durations (no sets) for that exercise
  const flatDurations = new Map();
  for (const plan of plans) {
    for (const e of plan.dailyExercises || []) {
      if (!(typeof e.durationMinutes === 'number' && e.durationMinutes > 0)) continue;
      if (typeof e.sets === 'number' && e.sets > 0) continue; // per-set plan: product is correct
      const key = `${plan.patientId}|${e.exerciseId}`;
      if (!flatDurations.has(key)) flatDurations.set(key, new Set());
      flatDurations.get(key).add(e.durationMinutes);
    }
  }

  const changes = [];
  let logsTouched = 0;
  const cursor = ExerciseLog.find({ 'exercises.sets': { $gt: 1 } }).cursor();
  for await (const log of cursor) {
    let touched = false;
    for (const entry of log.exercises) {
      if (!(typeof entry.sets === 'number' && entry.sets > 1)) continue;
      const durations = flatDurations.get(`${log.patientId}|${entry.exerciseId}`);
      if (!durations) continue;
      const flat = [...durations].find((d) => d * entry.sets === entry.durationMinutes);
      if (flat === undefined) continue;

      const newCalories = Math.round((entry.caloriesBurned || 0) * (flat / entry.durationMinutes));
      changes.push({
        logId: String(log._id),
        patientId: String(log.patientId),
        exerciseId: String(entry.exerciseId),
        date: log.date,
        sets: entry.sets,
        durationFrom: entry.durationMinutes,
        durationTo: flat,
        caloriesFrom: entry.caloriesBurned,
        caloriesTo: newCalories,
      });
      if (apply) {
        entry.durationMinutes = flat;
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

module.exports = { backfillInflatedExerciseLogs };
