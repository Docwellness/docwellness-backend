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
 * Every pause window recorded across ALL of a patient's diet-plan cycles,
 * merged into one normalized, de-duped, chronological list.
 *
 * A pause is stored on whichever DietPlan cycle was "current" when the
 * dietician scheduled it. After a renewal, `retireEndedPredecessorPlans`
 * flips that cycle to 'Completed' and the patient moves onto the next one -
 * which would strand a still-scheduled / running pause on a cycle nothing
 * reads anymore (the resume-date edit that "didn't show up", the window
 * that silently stopped applying). Reading the union keeps a pause visible
 * regardless of which cycle it physically lives on.
 */
async function loadPatientPauses(patientId) {
  const plans = await DietPlan.find({ patientId, 'pauses.0': { $exists: true } })
    .select('pauses')
    .lean();
  const seen = new Set();
  const merged = [];
  for (const plan of plans) {
    for (const w of plan.pauses || []) {
      if (!w || !w.startDate || !w.resumeDate) continue;
      const key = `${new Date(w.startDate).getTime()}|${new Date(w.resumeDate).getTime()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(w);
    }
  }
  return normalizePauses(merged);
}

/**
 * @returns {Promise<{ paused: boolean, resumeDate: Date|null }>}
 */
async function getPauseStateForLogging(patientId, when = new Date()) {
  const pauses = await loadPatientPauses(patientId);
  if (!isPausedOn(pauses, when)) return { paused: false, resumeDate: null };
  const win = currentOrUpcomingPause(pauses, when);
  return { paused: true, resumeDate: win?.resumeDate || null };
}

/**
 * Express helper: if paused, sends a 403 and returns true (caller should
 * `return`); otherwise returns false.
 *
 * `when` should be the date the write actually targets (e.g. the `date` in
 * the request body), not left to default to real "now" - a patient logging
 * against today (or any other non-paused day) must not be rejected just
 * because a *different* day is currently inside an active pause window.
 * Every call site used to omit it, so while any pause was active in real
 * time, every log attempt failed with this 403 regardless of which
 * (possibly unpaused) date it actually targeted.
 */
async function rejectIfPaused(res, patientId, when = new Date()) {
  const { paused, resumeDate } = await getPauseStateForLogging(patientId, when);
  if (!paused) return false;
  const whenMsg = resumeDate ? ` It resumes on ${resumeDate.toISOString().slice(0, 10)}.` : '';
  res.status(403).json({
    success: false,
    message: `Your plan is paused for this day, so logging is disabled.${whenMsg}`,
    code: 'PLAN_PAUSED',
    resumeDate: resumeDate || null,
  });
  return true;
}

module.exports = { loadPatientPauses, getPauseStateForLogging, rejectIfPaused };
