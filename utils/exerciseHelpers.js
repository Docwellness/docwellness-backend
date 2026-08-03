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

/**
 * A session's duration in minutes, estimated when the patient leaves the
 * log-time duration field blank. Priority: the dietician's own plan figure
 * (durationMinutes on the ExercisePlan entry) is authored per-set once sets
 * is also assigned - see ExercisePlan.js's own comment - so it's multiplied
 * by sets; with no sets it's already a flat total (e.g. "10 min jump
 * rope"). Falls back to the exercise catalog's AI-estimated secondsPerRep
 * (see models/Exercise.js) times reps/sets only when the plan gives no
 * duration at all. Returns null when there's genuinely nothing to estimate
 * from - callers should still require a manual duration in that case.
 */
function estimateDurationMinutes({ planDurationMinutes, sets, reps, secondsPerRep }) {
  if (typeof planDurationMinutes === 'number' && planDurationMinutes > 0) {
    return typeof sets === 'number' && sets > 0 ? planDurationMinutes * sets : planDurationMinutes;
  }
  if (typeof secondsPerRep === 'number' && secondsPerRep > 0 && typeof reps === 'number' && reps > 0) {
    const setsMultiplier = typeof sets === 'number' && sets > 0 ? sets : 1;
    return (secondsPerRep * reps * setsMultiplier) / 60;
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
