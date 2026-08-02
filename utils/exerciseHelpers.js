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

module.exports = { calcCaloriesBurned, resolvePatientWeightKg, DEFAULT_FALLBACK_WEIGHT_KG };
