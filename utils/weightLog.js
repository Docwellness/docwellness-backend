const { Progress, User } = require('../models');
const { calculateBMI } = require('./helpers');

/**
 * Records a weight entry as a Progress document and keeps
 * User.healthProfile.weight/bmi in sync. This is the single place any
 * weight update - a patient self-logging, or a dietician entering it during
 * diet-plan generation/finalization - should go through, so there's always
 * an auditable history of what weight informed which decision instead of a
 * blind overwrite of healthProfile.weight.
 */
async function logWeight(
  patientId,
  weight,
  { dieticianId = null, source = 'patient', dietPlanId = null, week = null, date = null } = {}
) {
  if (typeof weight !== 'number' || Number.isNaN(weight) || weight <= 0) {
    return null;
  }

  const user = await User.findById(patientId).select('healthProfile');
  const height = user?.healthProfile?.height;
  const bmi = height ? parseFloat(calculateBMI(weight, height)) : null;

  const progress = await Progress.create({
    patientId,
    dieticianId: dieticianId || undefined,
    date: date || new Date(),
    weight,
    bmi,
    source,
    dietPlanId: dietPlanId || undefined,
    week: week || undefined,
  });

  const profileUpdate = { 'healthProfile.weight': weight };
  if (bmi !== null && !Number.isNaN(bmi)) {
    profileUpdate['healthProfile.bmi'] = bmi;
  }
  await User.findByIdAndUpdate(patientId, profileUpdate);

  return progress;
}

module.exports = { logWeight };
