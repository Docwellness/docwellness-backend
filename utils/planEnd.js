/**
 * Plan end maths. A patient's plan "ends" on the Asia/Kolkata calendar day of
 * their latest DietPlanRequest.subscriptionExpiresAt. That timestamp already
 * includes any dietician pause shift (subscriptionPauseController adds the
 * pause length to it), so it is NOT shifted again here.
 *
 * The end day itself stays fully loggable. After it only one more weigh-in
 * is allowed: the earliest weekly Goal Journey milestone (pause-shifted)
 * strictly after the end day, else end day + 1. The weigh-in reminder must
 * import computeLastWeighInDate so it never nudges for a closed weigh-in.
 *
 * Day keys are plain 'YYYY-MM-DD' strings, so comparing them as strings is a
 * calendar comparison.
 */

const { DietPlanRequest, Goal, Milestone } = require('../models');
const { normDate, addDays, shiftDateForPauses } = require('./subscriptionPause');
const { loadPatientPauses } = require('./patientPauseGuard');

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

const utcDayKey = (date) => date.toISOString().slice(0, 10);

/** 'YYYY-MM-DD' of the Asia/Kolkata calendar day containing `date`, or null. */
function istDayKey(date) {
  if (date === null || date === undefined || date === '') return null;
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  return utcDayKey(new Date(d.getTime() + IST_OFFSET_MS));
}

/** The plan end day key for a stored expiry timestamp, or null when unknown. */
function endDayOf(subscriptionExpiresAt) {
  return istDayKey(subscriptionExpiresAt);
}

/**
 * Earliest pause-shifted weekly milestone strictly after `endDay`, else the
 * day after `endDay`. `weeklyMilestoneDates` may be unsorted.
 */
function computeLastWeighInDate({ endDay, weeklyMilestoneDates = [], pauses = [] }) {
  if (!endDay) return null;
  const shiftedKeys = weeklyMilestoneDates
    .map((d) => shiftDateForPauses(pauses, d))
    .filter(Boolean)
    .map(utcDayKey)
    .filter((key) => key > endDay)
    .sort();
  if (shiftedKeys.length) return shiftedKeys[0];
  return utcDayKey(addDays(normDate(endDay), 1));
}

const NO_PLAN_END = Object.freeze({
  endDay: null,
  lastWeighInDate: null,
  requestId: null,
  hasActivePlan: false,
});

/**
 * The patient's plan end from the latest request. The weekly milestones and
 * pauses are only read once the end day is today or past, so a running plan
 * costs one indexed query.
 *
 * @returns {Promise<{ endDay: string|null, lastWeighInDate: string|null,
 *   requestId: object|null, hasActivePlan: boolean }>}
 */
async function loadPlanEnd(patientId, now = new Date()) {
  const request = await DietPlanRequest.findOne({ patient: patientId })
    .sort({ createdAt: -1 })
    .select('subscriptionExpiresAt hasActivePlan')
    .lean();
  if (!request) return NO_PLAN_END;

  const base = { requestId: request._id, hasActivePlan: Boolean(request.hasActivePlan) };
  const endDay = endDayOf(request.subscriptionExpiresAt);
  if (!endDay) return { ...NO_PLAN_END, ...base };
  if (endDay > istDayKey(now)) return { ...NO_PLAN_END, ...base, endDay };

  const goal = await Goal.findOne({ patientId, status: 'active' }).sort({ createdAt: -1 }).select('_id').lean();
  const [milestones, pauses] = await Promise.all([
    goal ? Milestone.find({ goalId: goal._id, type: 'weekly' }).select('date').lean() : [],
    loadPatientPauses(patientId),
  ]);
  const lastWeighInDate = computeLastWeighInDate({
    endDay,
    weeklyMilestoneDates: milestones.map((m) => m.date),
    pauses,
  });
  return { ...base, endDay, lastWeighInDate };
}

/** True when `targetDayKey` is after the end day (no meal/water/exercise logging). */
function isNonWeightLogClosed(planEnd, targetDayKey) {
  return Boolean(planEnd?.endDay) && targetDayKey > planEnd.endDay;
}

/** True when `todayDayKey` is past the last allowed weigh-in date. */
function isWeightClosed(planEnd, todayDayKey) {
  return Boolean(planEnd?.lastWeighInDate) && todayDayKey > planEnd.lastWeighInDate;
}

module.exports = {
  istDayKey,
  endDayOf,
  computeLastWeighInDate,
  loadPlanEnd,
  isNonWeightLogClosed,
  isWeightClosed,
};
