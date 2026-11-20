/**
 * Start-day maths for a diet plan that is dated at payment approval. Days are
 * plain 'YYYY-MM-DD' strings in the Asia/Kolkata calendar (like utils/planEnd.js),
 * compared as strings, so the IST/UTC boundary can never shift the start by a day.
 * Stored dates are UTC midnight of the picked day, the way dietPlanWeek.js reads them.
 */

const { istDayKey } = require('./planEnd');
const { buildWeekSchedule } = require('./weekSchedule');
const { addDays } = require('./subscriptionPause');

const DAY_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MEMBERSHIP_DAYS = 30;

/** The day key when `value` is a strict, real 'yyyy-MM-dd' calendar day, else null. */
function parseStartDay(value) {
  if (typeof value !== 'string' || !DAY_KEY_PATTERN.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) return null;
  return value;
}

/** UTC midnight Date of a day key. */
function dayToUtcDate(dayKey) {
  return new Date(`${dayKey}T00:00:00.000Z`);
}

/** Day key `days` after `dayKey`. */
function addDaysToDay(dayKey, days) {
  return addDays(dayToUtcDate(dayKey), days).toISOString().slice(0, 10);
}

/**
 * The earliest allowed start day: today (IST), or the day after the running
 * cycle's end day when that is later.
 */
function earliestStartDay({ now = new Date(), runningEndDay = null } = {}) {
  const today = istDayKey(now);
  if (!runningEndDay) return today;
  const afterRunning = addDaysToDay(runningEndDay, 1);
  return afterRunning > today ? afterRunning : today;
}

/** Every date a plan and its request take from the picked start day. */
function activationDates(startDay) {
  const startDate = dayToUtcDate(startDay);
  return {
    startDate,
    weekSchedule: buildWeekSchedule(startDate),
    subscriptionExpiresAt: addDays(startDate, MEMBERSHIP_DAYS),
  };
}

module.exports = { parseStartDay, earliestStartDay, dayToUtcDate, addDaysToDay, activationDates };
