/**
 * Subscription pause maths. A dietician can pause a patient's plan for a
 * date window [startDate, resumeDate); during it the patient can't log
 * anything and the Diet & Exercise tab is locked. When it resumes, every
 * day of plan content shifts forward by the pause length - a pure calendar
 * shift: whatever was scheduled for `startDate` is served on `resumeDate`.
 *
 * Content stays where it is in the DB; the shift is virtual - resolvers
 * translate a real calendar date to the "effective" date whose content
 * should show. This is the only correct approach because within a week the
 * plan is a day-of-week rotation (see utils/dayGroups.js), so a
 * non-multiple-of-7 shift can't be done by moving weekSchedule ranges.
 *
 * `DietPlan.pauses` is an append-only-ish array of `{ startDate, resumeDate }`
 * windows (non-overlapping, chronological). Multiple pauses stack.
 *
 * The subscription expiry / goal end date / exercise plan end date ARE
 * mutated by the pause controller (single scalar values, many consumers) -
 * this module only does the content-date translation.
 *
 * All dates are handled as UTC calendar days, matching
 * controllers/patient/dietController.js's normalizeDate.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

const normDate = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
};

const addDays = (date, days) => new Date(normDate(date).getTime() + days * DAY_MS);

/** Whole calendar days from `a` to `b` (b - a). Negative if b is before a. */
const dayDiff = (a, b) => Math.round((normDate(b).getTime() - normDate(a).getTime()) / DAY_MS);

/** [{startDate, resumeDate}] -> only the well-formed, chronological windows. */
const normalizePauses = (pauses) =>
  (Array.isArray(pauses) ? pauses : [])
    .map((p) => ({ startDate: normDate(p.startDate), resumeDate: normDate(p.resumeDate) }))
    .filter((p) => p.startDate && p.resumeDate && p.resumeDate > p.startDate)
    .sort((a, b) => a.startDate - b.startDate);

/** Duration of one window in days. */
const pauseLengthDays = (window) => dayDiff(window.startDate, window.resumeDate);

/** True when `date` falls inside any pause window (start inclusive, resume exclusive). */
function isPausedOn(pauses, date) {
  const d = normDate(date);
  return normalizePauses(pauses).some((p) => d >= p.startDate && d < p.resumeDate);
}

/**
 * How many days of content shift apply to a real calendar `date`: the sum
 * of the lengths of every pause window that has already fully ended on or
 * before `date`. A date inside a window returns that window contributes 0
 * (the day is "paused", handled by isPausedOn, not shifted).
 */
function pauseShiftForDate(pauses, date) {
  const d = normDate(date);
  return normalizePauses(pauses)
    .filter((p) => p.resumeDate <= d)
    .reduce((sum, p) => sum + pauseLengthDays(p), 0);
}

/**
 * The "effective" content date for a real calendar `date`: the date whose
 * plan content (week + day-group) should be shown. Returns null when the
 * date is inside a pause window (nothing to show).
 */
function effectiveContentDate(pauses, date) {
  if (isPausedOn(pauses, date)) return null;
  const shift = pauseShiftForDate(pauses, date);
  return shift === 0 ? normDate(date) : addDays(date, -shift);
}

/** Total shift applied to the far future (all windows count) - for extending plan end / expiry display. */
function totalShiftDays(pauses) {
  return normalizePauses(pauses).reduce((sum, p) => sum + pauseLengthDays(p), 0);
}

/**
 * The pause window relevant to the UI right now: the one currently active,
 * else the next upcoming one, else null. `now` defaults to today.
 */
function currentOrUpcomingPause(pauses, now = new Date()) {
  const today = normDate(now);
  const list = normalizePauses(pauses);
  return (
    list.find((p) => today >= p.startDate && today < p.resumeDate) ||
    list.find((p) => p.startDate > today) ||
    null
  );
}

/** The last window that hasn't finished yet - the only one a dietician may edit/cancel. */
function editablePause(pauses, now = new Date()) {
  const today = normDate(now);
  const list = normalizePauses(pauses);
  const last = list[list.length - 1];
  return last && last.resumeDate > today ? last : null;
}

module.exports = {
  normDate,
  addDays,
  dayDiff,
  normalizePauses,
  pauseLengthDays,
  isPausedOn,
  pauseShiftForDate,
  effectiveContentDate,
  totalShiftDays,
  currentOrUpcomingPause,
  editablePause,
};
