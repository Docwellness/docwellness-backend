const { Goal, Milestone, MilestoneTask, User, Progress } = require('../models');

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// One task per MealLog serving-time (see models/MealLog.js's mealType enum -
// buildTimelinePayload matches a task's title against a patient's actual
// logged meals for that day by this exact string), plus Supplements, which
// has no dedicated log model and stays manually checked off via CheckIn.
const DEFAULT_DAILY_TASKS = [
  { title: 'Morning Drink', metric: '', icon: 'morning_drink', sortOrder: 1 },
  { title: 'Breakfast', metric: '', icon: 'breakfast', sortOrder: 2 },
  { title: 'Brunch', metric: '', icon: 'brunch', sortOrder: 3 },
  { title: 'Lunch', metric: '', icon: 'lunch', sortOrder: 4 },
  { title: 'Evening Snack', metric: '', icon: 'evening_snack', sortOrder: 5 },
  { title: 'Dinner', metric: '', icon: 'dinner', sortOrder: 6 },
  { title: 'Night Drink', metric: '', icon: 'night_drink', sortOrder: 7 },
  { title: 'Supplements', metric: '', icon: 'supplements', sortOrder: 8 },
];

// Titles that match a models/MealLog.js mealType exactly - buildTimelinePayload
// uses this set to know which tasks are log-linked (auto-done from real
// logs) vs manually checked off (Supplements).
const MEAL_LINKED_TASK_TITLES = new Set([
  'Morning Drink',
  'Breakfast',
  'Brunch',
  'Lunch',
  'Evening Snack',
  'Dinner',
  'Night Drink',
]);

function toDateOnly(d) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

// The plan's real start/end dates - prefers weekSchedule's week-1
// start/last-week end over the top-level startDate/endDate fields, which
// activateDietPlan never actually populates (confirmed live: every real
// activated plan has endDate === undefined; weekSchedule is the only place
// a plan's true dates are set). Deliberately UTC-based (not
// utils/trackingBuckets.js's resolvePlanStartDate, which truncates to
// LOCAL midnight for its own chart-bucketing use case) so these line up
// exactly with toDateOnly() and the rest of this file's UTC day boundaries
// - mixing the two conventions silently shifted seeded dates by a day in
// any non-UTC server timezone.
function resolvePlanStartDate(dietPlan) {
  const schedule = dietPlan?.weekSchedule;
  const raw =
    schedule && schedule.length > 0
      ? schedule[0].startDate
      : dietPlan?.activationDate || dietPlan?.startDate || null;
  return raw ? toDateOnly(new Date(raw)) : null;
}

function resolvePlanEndDate(dietPlan) {
  const schedule = dietPlan?.weekSchedule;
  const raw =
    schedule && schedule.length > 0
      ? schedule[schedule.length - 1].endDate
      : dietPlan?.endDate || null;
  return raw ? toDateOnly(new Date(raw)) : null;
}

function formatDayLabel(date) {
  return date.toLocaleDateString('en-US', { day: '2-digit', month: 'short', timeZone: 'UTC' });
}

function formatMonthLabel(date) {
  return date.toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' });
}

/**
 * Creates Milestone + MilestoneTask docs covering [rangeStart, rangeEnd]
 * (inclusive) for an existing goal. sortOrder for daily/weekly/monthly
 * follows the spec's convention (day-index for daily, 900 for weekly, 950
 * for monthly, 999 for the end-goal node) so the client can order a mixed
 * list without re-deriving type precedence.
 */
async function seedMilestonesForRange(goal, rangeStart, rangeEnd, { includeEndGoal }) {
  const start = toDateOnly(rangeStart);
  const end = toDateOnly(rangeEnd);
  const totalDays = Math.round((end - start) / MS_PER_DAY);

  const dailyDocs = [];
  for (let i = 0; i <= totalDays; i++) {
    const date = new Date(start.getTime() + i * MS_PER_DAY);
    dailyDocs.push({
      goalId: goal._id,
      type: 'daily',
      title: formatDayLabel(date),
      subtitle: 'Daily goals',
      date,
      sortOrder: i,
    });
  }

  // Weekly milestones every 7 days from the goal's own start (not the
  // range start), so week boundaries stay stable across renewal-triggered
  // range extensions instead of resetting per cycle.
  const goalStart = toDateOnly(goal.startDate);
  const weeklyDocs = [];
  for (let d = new Date(goalStart); d <= end; d = new Date(d.getTime() + 7 * MS_PER_DAY)) {
    if (d < start) continue;
    const weekNum = Math.floor((d - goalStart) / MS_PER_DAY / 7) + 1;
    weeklyDocs.push({
      goalId: goal._id,
      type: 'weekly',
      title: `Week ${weekNum}`,
      subtitle: 'Weekly checkpoint',
      date: d,
      sortOrder: 900,
    });
  }

  // Monthly milestones at each month boundary within the range.
  const monthlyDocs = [];
  let cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0));
  while (cursor <= end) {
    if (cursor >= start) {
      monthlyDocs.push({
        goalId: goal._id,
        type: 'monthly',
        title: formatMonthLabel(cursor),
        subtitle: 'Monthly milestone',
        date: cursor,
        sortOrder: 950,
      });
    }
    cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 2, 0));
  }

  const endGoalDocs = includeEndGoal
    ? [
        {
          goalId: goal._id,
          type: 'end_goal',
          title: `${goal.targetValue} ${goal.unit}`,
          subtitle: `Goal · ${formatDayLabel(toDateOnly(goal.endDate))} ${goal.endDate.getUTCFullYear()}`,
          date: toDateOnly(goal.endDate),
          sortOrder: 999,
        },
      ]
    : [];

  const allMilestoneDocs = [...dailyDocs, ...weeklyDocs, ...monthlyDocs, ...endGoalDocs];
  if (allMilestoneDocs.length === 0) return;

  const insertedMilestones = await Milestone.insertMany(allMilestoneDocs);

  const taskDocs = [];
  for (const milestone of insertedMilestones) {
    if (milestone.type !== 'daily') continue;
    for (const task of DEFAULT_DAILY_TASKS) {
      taskDocs.push({ milestoneId: milestone._id, ...task });
    }
  }
  if (taskDocs.length > 0) {
    await MilestoneTask.insertMany(taskDocs);
  }
}

/**
 * Called from activateDietPlan (fire-and-forget - must never throw into the
 * caller). Creates the patient's active Goal on first activation, seeding
 * its full timeline; on a later renewal (plan re-activated with a later
 * endDate), extends the existing goal's endDate and seeds only the newly
 * covered days instead of re-seeding everything or leaving the timeline
 * stuck at the first cycle's 4-week window.
 */
async function seedGoalTimeline(dietPlan) {
  const { patientId, dieticianId, _id: dietPlanId } = dietPlan;
  // weekSchedule is the only place a plan's real start/end dates are
  // reliably populated - activateDietPlan never sets the top-level
  // startDate/endDate fields themselves (confirmed against real data).
  const startDate = resolvePlanStartDate(dietPlan);
  const endDate = resolvePlanEndDate(dietPlan);
  if (!startDate || !endDate) {
    // No weekSchedule yet (plan finalized but never went through the
    // week-schedule-generating step) - nothing to seed a timeline from.
    return null;
  }

  const existingGoal = await Goal.findOne({ patientId, status: 'active' });

  if (existingGoal) {
    if (endDate > existingGoal.endDate) {
      const rangeStart = new Date(existingGoal.endDate.getTime() + MS_PER_DAY);
      const previousEndDate = existingGoal.endDate;
      existingGoal.endDate = endDate;
      existingGoal.dietPlanId = dietPlanId;
      await existingGoal.save();
      // Drop the old end-goal node (its date/subtitle are now stale) before
      // seeding the extended range with a fresh one.
      await Milestone.deleteOne({ goalId: existingGoal._id, type: 'end_goal' });
      await seedMilestonesForRange(existingGoal, rangeStart, endDate, { includeEndGoal: true });
      void previousEndDate; // kept for clarity in future diagnostics, not otherwise used
    }
    return existingGoal;
  }

  const user = await User.findById(patientId).select('healthProfile');
  const targetValue =
    parseFloat(String(user?.healthProfile?.targetWeight ?? '').replace(/[^0-9.-]/g, '')) || null;
  if (!targetValue) {
    // No target weight on file yet - nothing to build a goal toward.
    return null;
  }

  const latestProgress = await Progress.findOne({ patientId, weight: { $ne: null } })
    .sort({ date: -1 })
    .select('weight');
  let startValue = latestProgress?.weight ?? null;
  if (startValue == null && dietPlan.request?.currentWeight != null) {
    startValue = dietPlan.request.currentWeight;
  }
  if (startValue == null) {
    startValue = user?.healthProfile?.weight ?? null;
  }

  const goal = await Goal.create({
    patientId,
    dieticianId,
    dietPlanId,
    title: `Reach ${targetValue} kg`,
    startValue,
    currentValue: startValue,
    targetValue,
    unit: 'kg',
    startDate,
    endDate,
    status: 'active',
  });

  await seedMilestonesForRange(goal, startDate, endDate, { includeEndGoal: true });
  return goal;
}

module.exports = {
  seedGoalTimeline,
  seedMilestonesForRange,
  DEFAULT_DAILY_TASKS,
  MEAL_LINKED_TASK_TITLES,
};
