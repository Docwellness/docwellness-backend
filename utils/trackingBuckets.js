// Shared date-bucketing helpers for patient tracking-data endpoints
// (controllers/patient/progressController.js and controllers/dietician/
// trackingController.js both show the same BMI/Weight/Calorie trend data -
// the patient viewing their own history, the dietician viewing a specific
// patient's). Extracted here so the two never silently diverge the way
// several other "which week/date counts as current" computations did
// across this codebase before being unified this session.

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Get local date string YYYY-MM-DD without timezone shift
function localDateStr(date) {
  const d = new Date(date);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// Format date as "6 Jul" style
function formatShortDate(date) {
  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];
  return `${date.getDate()} ${months[date.getMonth()]}`;
}

// Sum meal calories from a meals array
function sumMealCalories(meals) {
  if (!Array.isArray(meals)) return 0;
  return meals.reduce((sum, meal) => sum + (meal.caloriesConsumed || 0), 0);
}

function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

// Splits [rangeStart, rangeEnd] into buckets sized to keep a chart readable
// regardless of how wide a range is picked - a bar per day for a short
// range, growing to weekly then monthly as the range widens.
function buildDateBuckets(rangeStart, rangeEnd) {
  const start = new Date(rangeStart);
  start.setHours(0, 0, 0, 0);
  const end = new Date(rangeEnd);
  end.setHours(0, 0, 0, 0);
  const totalDays = Math.round((end.getTime() - start.getTime()) / MS_PER_DAY) + 1;

  let granularity;
  if (totalDays <= 14) granularity = 'daily';
  else if (totalDays <= 84) granularity = 'weekly';
  else granularity = 'monthly';

  const buckets = [];

  if (granularity === 'daily') {
    for (let d = new Date(start); d <= end; d = addDays(d, 1)) {
      const bStart = new Date(d);
      bStart.setHours(0, 0, 0, 0);
      const bEnd = new Date(d);
      bEnd.setHours(23, 59, 59, 999);
      buckets.push({ start: bStart, end: bEnd, label: formatShortDate(bStart) });
    }
  } else if (granularity === 'weekly') {
    let cur = new Date(start);
    while (cur <= end) {
      const bStart = new Date(cur);
      bStart.setHours(0, 0, 0, 0);
      const bEndRaw = addDays(cur, 6) > end ? new Date(end) : addDays(cur, 6);
      const bEnd = new Date(bEndRaw);
      bEnd.setHours(23, 59, 59, 999);
      buckets.push({ start: bStart, end: bEnd, label: formatShortDate(bStart) });
      cur = addDays(cur, 7);
    }
  } else {
    const monthNames = [
      'Jan',
      'Feb',
      'Mar',
      'Apr',
      'May',
      'Jun',
      'Jul',
      'Aug',
      'Sep',
      'Oct',
      'Nov',
      'Dec',
    ];
    const spansMultipleYears = start.getFullYear() !== end.getFullYear();
    let cur = new Date(start.getFullYear(), start.getMonth(), 1);
    while (cur <= end) {
      const bStart = cur > start ? new Date(cur) : new Date(start);
      bStart.setHours(0, 0, 0, 0);
      const calendarMonthEnd = new Date(cur.getFullYear(), cur.getMonth() + 1, 0);
      const bEndRaw = calendarMonthEnd < end ? calendarMonthEnd : end;
      const bEnd = new Date(bEndRaw);
      bEnd.setHours(23, 59, 59, 999);
      const label = spansMultipleYears
        ? `${monthNames[cur.getMonth()]} '${String(cur.getFullYear()).slice(2)}`
        : monthNames[cur.getMonth()];
      buckets.push({ start: bStart, end: bEnd, label });
      cur = new Date(cur.getFullYear(), cur.getMonth() + 1, 1);
    }
  }

  return { buckets, granularity };
}

// The plan's real start date - prefers weekSchedule's week-1 start over
// activationDate, which can predate the plan's real first week. dietPlan
// must have weekSchedule/activationDate selected/populated by the caller.
function resolvePlanStartDate(dietPlan) {
  const resolved = dietPlan?.weekSchedule?.[0]?.startDate
    ? new Date(dietPlan.weekSchedule[0].startDate)
    : dietPlan?.activationDate
      ? new Date(dietPlan.activationDate)
      : null;
  if (resolved) resolved.setHours(0, 0, 0, 0);
  return resolved;
}


// Resolves + clamps the requested [startDate, endDate] query params against
// [earliestAllowed (plan start, or today if no plan), today] - shared
// clamping rules so both endpoints reject the same out-of-range requests
// the same way.
function resolveRequestedRange(query, resolvedPlanStart, today) {
  const earliestAllowed = resolvedPlanStart || today;
  let startDate = query.startDate ? new Date(query.startDate) : earliestAllowed;
  let endDate = query.endDate ? new Date(query.endDate) : today;
  if (Number.isNaN(startDate.getTime())) startDate = earliestAllowed;
  if (Number.isNaN(endDate.getTime())) endDate = today;
  startDate.setHours(0, 0, 0, 0);
  endDate.setHours(0, 0, 0, 0);
  if (startDate < earliestAllowed) startDate = new Date(earliestAllowed);
  if (endDate > today) endDate = new Date(today);
  if (startDate > endDate) startDate = new Date(endDate);
  endDate.setHours(23, 59, 59, 999);
  return { startDate, endDate, earliestAllowed };
}

module.exports = {
  MS_PER_DAY,
  localDateStr,
  formatShortDate,
  sumMealCalories,
  addDays,
  buildDateBuckets,
  resolvePlanStartDate,
  resolveRequestedRange,
};
