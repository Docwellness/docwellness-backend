// Shared day-of-week grouping for diet plans: Monday's meals repeat on
// Friday, Tuesday's on Saturday, Wednesday's on Sunday, Thursday is unique
// (see DocWellness Diet Plan 4page-4.pdf's actual 7-day template). Used by
// both the dietician-side controller (building/persisting the 4 groups)
// and the patient-side controller (resolving which group today falls
// into), kept here to avoid cross-imports between those two controllers.

const DAY_GROUPS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday'];

// JS Date.getDay(): 0=Sunday, 1=Monday, ..., 6=Saturday.
const WEEKDAY_TO_DAY_GROUP = {
  1: 'Monday',
  5: 'Monday',
  2: 'Tuesday',
  6: 'Tuesday',
  3: 'Wednesday',
  0: 'Wednesday',
  4: 'Thursday',
};

function resolveDayGroupForDate(date) {
  return WEEKDAY_TO_DAY_GROUP[date.getDay()];
}

// A meal with no dayGroup is pre-migration data (generated before this
// phase) - treated as applying to every group, preserving its old "same
// every day" behavior with zero data migration needed.
function mealMatchesDayGroup(meal, dayGroup) {
  return !meal?.dayGroup || meal.dayGroup === dayGroup;
}

module.exports = { DAY_GROUPS, resolveDayGroupForDate, mealMatchesDayGroup };
