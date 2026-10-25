/**
 * Plan end maths. A patient's plan "ends" on the last day of the current diet
 * plan's last scheduled week, shifted by the patient's pause windows (the same
 * "shown in the apps" date the admin Plan dates panel calls the last plan
 * week), NOT on the membership expiry: the membership (activation + 30 days)
 * can run up to ~8 days past the last week when a plan is activated mid-week.
 * A plan with no week schedule falls back to the Asia/Kolkata day of
 * DietPlanRequest.subscriptionExpiresAt, which already includes the pause
 * shift and so is not shifted again.
 *
 * The end day itself stays fully loggable. After it only one more weigh-in
 * is allowed: the earliest weekly Goal Journey milestone (pause-shifted)
 * strictly after the end day, else end day + 1. The weigh-in reminder must
 * import computeLastWeighInDate so it never nudges for a closed weigh-in.
 *
 * Day keys are plain 'YYYY-MM-DD' strings, so comparing them as strings is a
 * calendar comparison.
 */

const { DietPlan, DietPlanRequest, Goal, Milestone } = require('../models');
const { normDate, addDays, shiftDateForPauses, shiftWeekRangeForPauses } = require('./subscriptionPause');
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
 * The plan's last scheduled week end as a pause-shifted 'YYYY-MM-DD', or null
 * when the plan has no dated week.
 */
function lastWeekEndDayOf(weekSchedule, pauses = []) {
  let last = null;
  for (const week of Array.isArray(weekSchedule) ? weekSchedule : []) {
    const start = normDate(week?.startDate);
    const end = normDate(week?.endDate);
    if (!start || !end) continue;
    const shifted = shiftWeekRangeForPauses(pauses, start, end).endDate;
    if (shifted && (!last || shifted > last)) last = shifted;
  }
  return last ? utcDayKey(last) : null;
}

/**
 * The plan the patient is on: the lowest-cycle Active plan (a renewal's
 * earlier cycle stays Active until its last week finishes), else the newest.
 */
async function loadCurrentPlan(patientId) {
  const select = 'weekSchedule cycleNumber';
  const active = await DietPlan.findOne({ patientId, status: 'Active' })
    .sort({ cycleNumber: 1 })
    .select(select)
    .lean();
  if (active) return active;
  return DietPlan.findOne({ patientId }).sort({ cycleNumber: -1, createdAt: -1 }).select(select).lean();
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
 * The patient's plan end from the current plan's weeks (membership expiry as
 * the fallback). The weekly milestones are only read once the end day is today
 * or past.
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
  const [plan, pauses] = await Promise.all([loadCurrentPlan(patientId), loadPatientPauses(patientId)]);
  const endDay = lastWeekEndDayOf(plan?.weekSchedule, pauses) || endDayOf(request.subscriptionExpiresAt);
  if (!endDay) return { ...NO_PLAN_END, ...base };
  if (endDay > istDayKey(now)) return { ...NO_PLAN_END, ...base, endDay };

  const goal = await Goal.findOne({ patientId, status: 'active' }).sort({ createdAt: -1 }).select('_id').lean();
  const milestones = goal ? await Milestone.find({ goalId: goal._id, type: 'weekly' }).select('date').lean() : [];
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
  lastWeekEndDayOf,
  computeLastWeighInDate,
  loadPlanEnd,
  isNonWeightLogClosed,
  isWeightClosed,
};
