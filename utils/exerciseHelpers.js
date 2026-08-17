// Pure calorie-burn math + weight resolution for the Exercise Plan feature -
// mirrors utils/dieticianPatientHelpers.js's calcBmr/calcTdee defensive-
// guard style (return null on bad input rather than throwing or silently
// producing NaN).

const { Progress, User } = require('../models');

/**
 * caloriesBurned = MET * weightKg * durationHours - the standard exercise-
 * science formula. Always computed server-side (see ExerciseLog.js's own
 * comment) - never trust a client-sent calorie figure for this, unlike
 * MealLog's caloriesConsumed which is a scaled recipe-nutrition figure the
 * server already authors and trusts.
 */
function calcCaloriesBurned({ met, weightKg, durationMinutes }) {
  if (
    typeof met !== 'number' ||
    typeof weightKg !== 'number' ||
    typeof durationMinutes !== 'number' ||
    Number.isNaN(met) ||
    Number.isNaN(weightKg) ||
    Number.isNaN(durationMinutes) ||
    met <= 0 ||
    weightKg <= 0 ||
    durationMinutes <= 0
  ) {
    return null;
  }
  return Math.round(met * weightKg * (durationMinutes / 60));
}

// Fallback average seconds for one repetition, used only when the exercise
// catalog's own AI-estimated secondsPerRep (see models/Exercise.js) is
// missing - which, as of writing, is every single catalog entry: the
// seed/import paths that built it (see scripts/seed-home-workout-
// exercises.js) never ran the AI generation step that populates this
// field, so any exercise assigned by sets/reps alone (no explicit plan
// duration) always fell through to "enter how many minutes" even though
// reps were right there to estimate from. A moderate, controlled-pace
// bodyweight rep (the catalog's own examples: crunches, squats, push-ups)
// comfortably falls within this schema's own secondsPerRep range (1-60) -
// not exact for every exercise, but a reasonable default beats blocking
// the log outright for data this codebase should have generated already.
const DEFAULT_SECONDS_PER_REP = 3;

/**
 * A session's duration in minutes, estimated when the patient leaves the
 * log-time duration field blank. Priority: the dietician's own plan figure
 * (durationMinutes on the ExercisePlan entry) is authored per-set once sets
 * is also assigned - see ExercisePlan.js's own comment - so it's multiplied
 * by sets; with no sets it's already a flat total (e.g. "10 min jump
 * rope"). Falls back to reps * secondsPerRep (the exercise catalog's own
 * AI-estimated value when present, else DEFAULT_SECONDS_PER_REP above) only
 * when the plan gives no duration at all. Returns null only when there's
 * genuinely nothing to estimate from at all - no plan duration and no reps
 * (a pure time-based exercise, e.g. a plank/hold with no rep count of its
 * own) - callers should still require a manual duration in that case.
 */
function estimateDurationMinutes({ planDurationMinutes, sets, reps, secondsPerRep }) {
  if (typeof planDurationMinutes === 'number' && planDurationMinutes > 0) {
    return typeof sets === 'number' && sets > 0 ? planDurationMinutes * sets : planDurationMinutes;
  }
  if (typeof reps === 'number' && reps > 0) {
    const perRep =
      typeof secondsPerRep === 'number' && secondsPerRep > 0 ? secondsPerRep : DEFAULT_SECONDS_PER_REP;
    const setsMultiplier = typeof sets === 'number' && sets > 0 ? sets : 1;
    return (perRep * reps * setsMultiplier) / 60;
  }
  return null;
}

// Average adult weight (kg) - last-resort fallback only, when a patient has
// neither a logged Progress entry nor a healthProfile.weight on file. Flags
// loudly via the caller's own handling rather than silently producing a
// calorie figure that looks precise but is actually a population guess.
const DEFAULT_FALLBACK_WEIGHT_KG = 70;

/**
 * The patient's current weight in kg, via the same fallback chain
 * seedGoalTimeline.js already uses for the same purpose (latest logged
 * Progress.weight, then User.healthProfile.weight) - kept as one shared
 * resolver so "the patient's current weight" is never resolved two
 * different ways in the codebase. Returns null (not a guessed default) when
 * neither source exists - callers decide how to handle that themselves.
 */
async function resolvePatientWeightKg(patientId) {
  const latestProgress = await Progress.findOne({ patientId, weight: { $ne: null } })
    .sort({ date: -1 })
    .select('weight');
  if (latestProgress?.weight != null) {
    return latestProgress.weight;
  }

  const user = await User.findById(patientId).select('healthProfile.weight');
  const parsed = parseFloat(user?.healthProfile?.weight);
  if (!Number.isNaN(parsed) && parsed > 0) {
    return parsed;
  }

  return null;
}

module.exports = { calcCaloriesBurned, estimateDurationMinutes, resolvePatientWeightKg, DEFAULT_FALLBACK_WEIGHT_KG };
