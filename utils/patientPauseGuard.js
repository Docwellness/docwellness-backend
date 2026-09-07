/**
 * Shared "is this patient's plan paused today?" check for the patient-side
 * write paths (meal / water / exercise logging). Returns a `{ paused,
 * resumeDate }` object; controllers 403 when `paused` is true.
 *
 * Kept out of utils/subscriptionPause.js so that module stays pure maths
 * (no model imports).
 */

const { DietPlan } = require('../models');
const { normalizePauses, isPausedOn, currentOrUpcomingPause } = require('./subscriptionPause');

/**
 * @returns {Promise<{ paused: boolean, resumeDate: Date|null }>}
 */
async function getPauseStateForLogging(patientId, when = new Date()) {
  const plan = await DietPlan.findOne({ patientId, status: 'Active' })
    .select('pauses')
    .sort({ cycleNumber: 1 })
    .lean();
  const pauses = normalizePauses(plan?.pauses);
  if (!isPausedOn(pauses, when)) return { paused: false, resumeDate: null };
  const win = currentOrUpcomingPause(pauses, when);
  return { paused: true, resumeDate: win?.resumeDate || null };
}

/**
 * Express helper: if paused, sends a 403 and returns true (caller should
 * `return`); otherwise returns false.
 */
async function rejectIfPaused(res, patientId) {
  const { paused, resumeDate } = await getPauseStateForLogging(patientId);
  if (!paused) return false;
  const when = resumeDate ? ` It resumes on ${resumeDate.toISOString().slice(0, 10)}.` : '';
  res.status(403).json({
    success: false,
    message: `Your plan is paused right now, so logging is disabled.${when}`,
    code: 'PLAN_PAUSED',
    resumeDate: resumeDate || null,
  });
  return true;
}

module.exports = { getPauseStateForLogging, rejectIfPaused };
