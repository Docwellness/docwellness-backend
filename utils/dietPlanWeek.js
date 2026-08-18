// Shared "which of the plan's 4 weeks does this date fall into" resolver.
// Extracted from controllers/patient/dietController.js so the dietician-facing
// controllers/dietician/trackingController.js (getPatientMealLogStats) can't
// silently diverge from it again - it previously carried its own inline
// diff-from-start estimate that ignored weekSchedule entirely, so a week that
// had been individually rescheduled (see utils/weekSchedule.js) made the
// dietician's "Client Logged Data" view compute totalPlannedCalories against
// the wrong week's dailyMeals, while the patient app (already using
// resolveCurrentWeek below) showed the correct week - the two apps' calorie
// rings disagreeing for the same day/patient.

const parseDateOrNull = (value) => {
  if (!value) {
    return null;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed;
};

// UTC-based, not local-timezone-based: dates travel between client/server as
// plain "yyyy-MM-dd" strings, which JS always parses as UTC midnight. Using
// local getters here made the stripped-down date drift by the server's UTC
// offset whenever it wasn't exactly 0.
const normalizeDate = (dateObj) =>
  new Date(Date.UTC(dateObj.getUTCFullYear(), dateObj.getUTCMonth(), dateObj.getUTCDate()));

// The plan's real week-1 start date - prefers weekSchedule (the same anchor
// used to build weekStartDate/weekEndDate everywhere else, and what the
// dietician actually picked/rescheduled) over activationDate/
// request.startDateForDiet, which can diverge from it (e.g. a plan finalized
// on one day but scheduled to actually start on another). Falls back to the
// activation/request chain only for legacy plans that predate weekSchedule
// being populated.
const resolvePlanStartDate = (dietPlan) => {
  const weekScheduleEntries = Array.isArray(dietPlan.weekSchedule) ? dietPlan.weekSchedule : [];
  const week1Entry = weekScheduleEntries.find((entry) => Number(entry.week) === 1);
  const week1Start = week1Entry ? parseDateOrNull(week1Entry.startDate) : null;
  if (week1Start) {
    return week1Start;
  }
  const activationStart = parseDateOrNull(dietPlan.activationDate);
  const requestStart = parseDateOrNull(dietPlan.request?.startDateForDiet);
  return activationStart || requestStart;
};

// Which of the plan's 4 weeks referenceDate falls into - prefers matching
// against weekSchedule's actual date ranges (same source of truth as
// resolvePlanStartDate/weekStartDate/weekEndDate) over a diff-from-start
// estimate, which can silently disagree with it once a week's date has been
// individually rescheduled. Falls back to the diff estimate only for legacy
// plans that predate weekSchedule.
const resolveCurrentWeek = (dietPlan, referenceDate) => {
  const weekScheduleEntries = Array.isArray(dietPlan.weekSchedule) ? dietPlan.weekSchedule : [];
  if (weekScheduleEntries.length > 0) {
    const refTime = normalizeDate(referenceDate).getTime();
    const matchedEntry = weekScheduleEntries.find((entry) => {
      const entryStart = normalizeDate(entry.startDate).getTime();
      const entryEnd = normalizeDate(entry.endDate).getTime();
      return refTime >= entryStart && refTime <= entryEnd;
    });
    if (matchedEntry) {
      return matchedEntry.week;
    }
    if (refTime < normalizeDate(weekScheduleEntries[0].startDate).getTime()) {
      return weekScheduleEntries[0].week;
    }
    return weekScheduleEntries[weekScheduleEntries.length - 1].week;
  }

  const startDate = resolvePlanStartDate(dietPlan);
  if (!startDate) {
    return 1;
  }
  const startDay = normalizeDate(startDate);
  const todayDay = normalizeDate(referenceDate);
  const diffDays = Math.floor((todayDay.getTime() - startDay.getTime()) / (1000 * 60 * 60 * 24));
  let computedWeek = Math.floor(diffDays / 7) + 1;
  if (computedWeek < 1) computedWeek = 1;
  if (computedWeek > 4) computedWeek = 4;
  return computedWeek;
};

module.exports = {
  parseDateOrNull,
  normalizeDate,
  resolvePlanStartDate,
  resolveCurrentWeek,
};
