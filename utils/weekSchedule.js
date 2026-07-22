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

module.exports = { buildWeekSchedule };
