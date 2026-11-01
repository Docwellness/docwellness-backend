// Shared date-bucketing helpers for patient tracking-data endpoints
// (controllers/patient/progressController.js and controllers/dietician/
// trackingController.js both show the same BMI/Weight/Calorie trend data -
// the patient viewing their own history, the dietician viewing a specific
// patient's). Extracted here so the two never silently diverge the way
// several other "which week/date counts as current" computations did
// across this codebase before being unified this session.

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Every day in this file is a UTC calendar day: MealLog.date and Progress
// check-in days are stored at UTC midnight, so server-local getters shifted
// bucket edges by a day on any host that is not in UTC.

// UTC date string YYYY-MM-DD (name kept for the existing callers)
function localDateStr(date) {
  const d = new Date(date);
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

const SHORT_MONTHS = [
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

// Format date as "6 Jul" style
function formatShortDate(date) {
  return `${date.getUTCDate()} ${SHORT_MONTHS[date.getUTCMonth()]}`;
}

// UTC midnight of the given instant's UTC day
function utcDay(date) {
  const d = new Date(date);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function endOfUtcDay(day) {
  return new Date(day.getTime() + MS_PER_DAY - 1);
}

// Sum meal calories from a meals array
function sumMealCalories(meals) {
  if (!Array.isArray(meals)) return 0;
  return meals.reduce((sum, meal) => sum + (meal.caloriesConsumed || 0), 0);
}

function addDays(date, n) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + n);
  return d;
}

// Splits [rangeStart, rangeEnd] into buckets sized to keep a chart readable
// regardless of how wide a range is picked - a bar per day for a short
// range, growing to weekly then monthly as the range widens.
function buildDateBuckets(rangeStart, rangeEnd) {
  const start = utcDay(rangeStart);
  const end = utcDay(rangeEnd);
  const totalDays = Math.round((end.getTime() - start.getTime()) / MS_PER_DAY) + 1;

  let granularity;
  if (totalDays <= 31) granularity = 'daily';
  else if (totalDays <= 126) granularity = 'weekly';
  else granularity = 'monthly';

  const buckets = [];
  // `start`/`end` are the instants (UTC midnight, last ms of the day);
  // `startDate`/`endDate` are the same days as YYYY-MM-DD keys.
  const pushBucket = (bStartDay, bEndDay, label) =>
    buckets.push({
      start: bStartDay,
      end: endOfUtcDay(bEndDay),
      startDate: localDateStr(bStartDay),
      endDate: localDateStr(bEndDay),
      label,
    });

  if (granularity === 'daily') {
    for (let d = start; d <= end; d = addDays(d, 1)) {
      pushBucket(d, d, formatShortDate(d));
    }
  } else if (granularity === 'weekly') {
    for (let cur = start; cur <= end; cur = addDays(cur, 7)) {
      const weekEnd = addDays(cur, 6);
      pushBucket(cur, weekEnd > end ? end : weekEnd, formatShortDate(cur));
    }
  } else {
    const spansMultipleYears = start.getUTCFullYear() !== end.getUTCFullYear();
    let cur = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
    while (cur <= end) {
      const calendarMonthEnd = new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth() + 1, 0));
      const label = spansMultipleYears
        ? `${SHORT_MONTHS[cur.getUTCMonth()]} '${String(cur.getUTCFullYear()).slice(2)}`
        : SHORT_MONTHS[cur.getUTCMonth()];
      pushBucket(cur > start ? cur : start, calendarMonthEnd < end ? calendarMonthEnd : end, label);
      cur = new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth() + 1, 1));
    }
  }

  return { buckets, granularity };
}

// One bucket per UTC day in [rangeStart, rangeEnd], whatever the range width -
// the calorie chart is always daily (the weight/BMI series keep
// buildDateBuckets' daily/weekly/monthly sizes).
function buildDailyBuckets(rangeStart, rangeEnd) {
  const start = utcDay(rangeStart);
  const end = utcDay(rangeEnd);
  const buckets = [];
  for (let d = start; d <= end; d = addDays(d, 1)) {
    buckets.push({
      start: d,
      end: endOfUtcDay(d),
      startDate: localDateStr(d),
      endDate: localDateStr(d),
      label: formatShortDate(d),
    });
  }
  return buckets;
}

// Per-day calorie items for the Progress calorie chart. Meal logs are indexed
// by UTC day once, so the cost is O(days + logs). `plannedByDay` maps a day key
// to that day's target kcal; a day with no entry has no target (0).
function buildCalorieData({ dailyBuckets, mealLogs, plannedByDay }) {
  const logsByDay = new Map();
  for (const log of mealLogs || []) {
    const key = localDateStr(log.date);
    if (!logsByDay.has(key)) logsByDay.set(key, []);
    logsByDay.get(key).push(log);
  }
  return dailyBuckets.map((bucket) => {
    const dayLogs = logsByDay.get(bucket.startDate) || [];
    const totalCalories = dayLogs.reduce(
      (sum, log) => sum + (log.totalCalories || sumMealCalories(log.meals)),
      0
    );
    const avgCalories = dayLogs.length > 0 ? totalCalories / dayLogs.length : 0;
    return {
      label: bucket.label,
      dateRange: `${formatShortDate(bucket.start)} - ${formatShortDate(bucket.end)}`,
      startDate: bucket.startDate,
      endDate: bucket.endDate,
      calories: Math.round(avgCalories),
      totalCalories: Math.round(totalCalories),
      plannedCalories: plannedByDay.get(bucket.startDate) ?? 0,
      daysLogged: dayLogs.length,
    };
  });
}

// Index of the bucket holding `now`, or -1 when it is outside the range.
function currentBucketIndex(buckets, now) {
  return buckets.findIndex((b) => now >= b.start && now <= b.end);
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

// Same start as resolvePlanStartDate, as a UTC calendar day - the convention
// of the tracking buckets and of the weekSchedule dates, which are stored at
// UTC midnight. resolvePlanStartDate keeps its local-midnight result for its
// other callers (pastOrders, dietController).
function resolvePlanStartUtcDay(dietPlan) {
  const raw = dietPlan?.weekSchedule?.[0]?.startDate || dietPlan?.activationDate;
  return raw ? utcDay(raw) : null;
}

// The earliest date this patient has any plan history for - the earliest
// resolvePlanStartDate across ALL their plans (renewal cycles included), not
// just the currently active one. A repurchase starts a new cycle whose week 1
// is later than the patient's first plan, so flooring the Progress charts at
// the active cycle's start hid every earlier week. Falls back to `fallback`
// (the active plan's start) when no plan resolves a start.
function resolveHistoryStartDate(dietPlans, fallback = null) {
  let earliest = null;
  for (const plan of dietPlans || []) {
    const start = resolvePlanStartUtcDay(plan);
    if (start && !Number.isNaN(start.getTime()) && (!earliest || start < earliest)) {
      earliest = start;
    }
  }
  if (!earliest) return fallback;
  return fallback && fallback < earliest ? fallback : earliest;
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
  startDate = utcDay(startDate);
  endDate = utcDay(endDate);
  const earliestDay = utcDay(earliestAllowed);
  const todayDay = utcDay(today);
  if (startDate < earliestDay) startDate = earliestDay;
  if (endDate > todayDay) endDate = todayDay;
  if (startDate > endDate) startDate = new Date(endDate);
  endDate = endOfUtcDay(endDate);
  return { startDate, endDate, earliestAllowed: earliestDay };
}

// Weight trend for the Progress charts: the planned line, re-based at each
// weekly-checkpoint weigh-in (see utils/weightTrendRebase.js), plus each
// bucket's measured weight. Kept for existing imports: `loggedByDay`
// (YYYY-MM-DD -> kg) are untagged weigh-ins, so they plot as measured points
// and never re-base; the line runs from the goal start weight on
// `cumulativeStart` to the target `planSpanDays` later.
function buildWeightTrend({
  buckets,
  loggedByDay,
  goalStartWeight,
  goalTargetWeight,
  planSpanDays,
  cumulativeStart,
  today,
  now,
  currentWeight,
}) {
  // Required here, not at the top: weightTrendRebase imports this module.
  const { buildRebasedWeightTrend } = require('./weightTrendRebase');
  const historyStart = utcDay(cumulativeStart);
  return buildRebasedWeightTrend({
    buckets,
    today,
    now,
    currentWeight,
    goalStartWeight,
    goalTargetWeight,
    goalEnd: new Date(historyStart.getTime() + planSpanDays * MS_PER_DAY),
    historyStart,
    weighIns: [...loggedByDay].map(([day, weight]) => ({
      date: new Date(`${day}T00:00:00.000Z`),
      weight,
      displayWeek: null,
    })),
  });
}

module.exports = {
  buildWeightTrend,
  MS_PER_DAY,
  localDateStr,
  formatShortDate,
  sumMealCalories,
  addDays,
  buildDateBuckets,
  buildDailyBuckets,
  buildCalorieData,
  currentBucketIndex,
  resolvePlanStartDate,
  resolvePlanStartUtcDay,
  resolveHistoryStartDate,
  resolveRequestedRange,
};
