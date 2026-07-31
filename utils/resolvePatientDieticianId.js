const { DietPlan } = require('../models');
const config = require('../config/environment');

// Same assignment rule used across the patient-facing "assigned dietician's
// content" endpoints (quotes, videos, and now social media/articles/reviews):
// prefer the dietician on the patient's own DietPlan, falling back to the
// configured default dietician for patients without one yet.
async function resolvePatientDieticianId(patientId) {
  const plan = await DietPlan.findOne({ patientId }).select('dieticianId').lean();
  if (plan?.dieticianId) return plan.dieticianId;
  return config.defaultDieticianId || null;
}

module.exports = { resolvePatientDieticianId };
