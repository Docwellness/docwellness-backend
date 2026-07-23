const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Builds the 4 week-date-ranges for one diet-plan cycle, each 7 days long,
// back-to-back starting at anchorStartDate (the cycle's own week-1 start -
// either the dietician-picked date on first generation, or a renewal's new
// cycle start). Populated for all 4 weeks up front regardless of tier or
// how many weeks have actually been generated yet, since even a still-locked
// week needs a displayable date range and a known end-of-week boundary for
// the finalize+2-day eligibility gate (see membershipTiers.js).
function buildWeekSchedule(anchorStartDate) {
  const anchor = new Date(anchorStartDate);
  return [1, 2, 3, 4].map((week) => {
    const startDate = new Date(anchor.getTime() + (week - 1) * 7 * MS_PER_DAY);
    const endDate = new Date(anchor.getTime() + (week * 7 - 1) * MS_PER_DAY);
    return { week, startDate, endDate };
  });
}

// Builds date ranges for an arbitrary, specific set of week numbers (e.g.
// Golden's [3, 4] pair, or a single Platinum week), sequential and 7 days
// each starting at anchorStartDate - used when the dietician updates/picks
// a date for a week (or week-pair) independently of the plan's original
// week-1 anchor, so "every week's date can be updated, just keep it 7 days
// from whichever day is selected" (product decision - dates are no longer
// rigidly derived from week 1 once a week is (re)generated with its own
// chosen date). weekNumbers is assumed pre-sorted ascending.
function buildSequentialWeekEntries(weekNumbers, anchorStartDate) {
  const anchor = new Date(anchorStartDate);
  return weekNumbers.map((week, index) => {
    const startDate = new Date(anchor.getTime() + index * 7 * MS_PER_DAY);
    const endDate = new Date(anchor.getTime() + ((index + 1) * 7 - 1) * MS_PER_DAY);
    return { week, startDate, endDate };
  });
}

// Merges newEntries into an existing weekSchedule array, replacing any
// entry whose week number matches and leaving all other weeks' entries
// untouched. Returns a new array (doesn't mutate the input).
function mergeWeekSchedule(existingSchedule, newEntries) {
  const byWeek = new Map((existingSchedule || []).map((entry) => [entry.week, entry]));
  for (const entry of newEntries) {
    byWeek.set(entry.week, entry);
  }
  return Array.from(byWeek.values()).sort((a, b) => a.week - b.week);
}

// Moves changedWeek to start at newStartDate (spanning 7 days), and cascades
// every later week (changedWeek+1..N, whichever exist in existingSchedule)
// to follow it back-to-back - so nudging one week's date can't leave a gap
// or overlap with the weeks after it. Weeks *before* changedWeek are left
// untouched (you can't reschedule the past). This is the fix for the
// mergeWeekSchedule-only approach generateWeekForExistingPlan uses today,
// which replaces just the week(s) being generated and leaves every later
// week's date exactly where it was - fine for that endpoint's own narrower
// purpose (picking a date while generating that week's content), but wrong
// for a dedicated "move this week's date" action, where the whole point is
// that everything downstream shifts with it.
function cascadeWeekScheduleFrom(existingSchedule, changedWeek, newStartDate) {
  const weeksToCascade = (existingSchedule || [])
    .map((entry) => entry.week)
    .filter((week) => week >= changedWeek)
    .sort((a, b) => a - b);
  const newEntries = buildSequentialWeekEntries(weeksToCascade, newStartDate);
  return mergeWeekSchedule(existingSchedule, newEntries);
}

module.exports = {
  buildWeekSchedule,
  buildSequentialWeekEntries,
  mergeWeekSchedule,
  cascadeWeekScheduleFrom,
};
