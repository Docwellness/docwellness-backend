const { Goal, Milestone, MilestoneTask, User, Progress } = require('../models');

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const DEFAULT_DAILY_TASKS = [
  { title: 'Log all 3 meals', metric: '3 meals', icon: 'restaurant', sortOrder: 1 },
  { title: 'Drink water', metric: '8 glasses', icon: 'water_drop', sortOrder: 2 },
  { title: 'Walk', metric: '30 min', icon: 'walk', sortOrder: 3 },
  { title: 'Sleep by 11 pm', metric: '7+ hrs', icon: 'sleep', sortOrder: 4 },
];

function toDateOnly(d) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
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
  const { patientId, dieticianId, _id: dietPlanId, startDate, endDate } = dietPlan;

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

module.exports = { seedGoalTimeline, seedMilestonesForRange, DEFAULT_DAILY_TASKS };
