// Goal Journey Timeline adherence/streak/pace computation - all done on
// read (no materialized daily_adherence table, see utils/seedGoalTimeline.js
// and the plan doc's reasoning: patient-scale data here doesn't need a
// nightly batch job, and computing on read can't drift from the underlying
// CheckIn documents).
//
// This is a THIRD, intentionally distinct streak metric from the two
// already in this codebase - controllers/patient/progressController.js's
// calorie-budget streak, and controllers/dietician/dietPlanController.js's
// meal-logged streak. Always call this one `goalStreak`, never bare
// "streak", to keep it unambiguous next to those two.

const { MS_PER_DAY } = require('./trackingBuckets');
const { Milestone, MilestoneTask, CheckIn, Goal, Progress } = require('../models');

const ADHERENCE_COMPLETE_THRESHOLD = 0.6;

function dateKeyUTC(date) {
  return new Date(date).toISOString().slice(0, 10);
}

function startOfTodayUTC() {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/**
 * Batches task + check-in lookups for a set of milestones into one query
 * each (not one per milestone), returning
 * Map<milestoneId string, { tasksTotal, tasksDone, adherence }>.
 * adherence is 0 for a milestone with no tasks at all (weekly/monthly/
 * end_goal nodes don't get default tasks - see seedGoalTimeline.js) rather
 * than NaN/undefined.
 */
async function computeAdherenceForMilestones(milestoneIds) {
  const result = new Map();
  if (!milestoneIds || milestoneIds.length === 0) return result;

  const tasks = await MilestoneTask.find({ milestoneId: { $in: milestoneIds } })
    .select('milestoneId')
    .lean();

  const tasksByMilestone = new Map();
  for (const t of tasks) {
    const key = t.milestoneId.toString();
    if (!tasksByMilestone.has(key)) tasksByMilestone.set(key, []);
    tasksByMilestone.get(key).push(t._id.toString());
  }

  const taskIds = tasks.map((t) => t._id);
  const checkIns = taskIds.length
    ? await CheckIn.find({ taskId: { $in: taskIds } }).select('taskId milestoneId').lean()
    : [];

  const doneTaskIdsByMilestone = new Map();
  for (const c of checkIns) {
    const key = c.milestoneId.toString();
    if (!doneTaskIdsByMilestone.has(key)) doneTaskIdsByMilestone.set(key, new Set());
    doneTaskIdsByMilestone.get(key).add(c.taskId.toString());
  }

  for (const milestoneId of milestoneIds) {
    const key = milestoneId.toString();
    const taskIdsForM = tasksByMilestone.get(key) || [];
    const doneSet = doneTaskIdsByMilestone.get(key) || new Set();
    const tasksTotal = taskIdsForM.length;
    const tasksDone = taskIdsForM.filter((id) => doneSet.has(id)).length;
    const adherence = tasksTotal === 0 ? 0 : tasksDone / tasksTotal;
    result.set(key, { tasksTotal, tasksDone, adherence });
  }

  return result;
}

/**
 * 'completed' | 'missed' | 'active' | 'upcoming'. A milestone with no tasks
 * at all (a weekly/monthly/end_goal node the dietician hasn't customized)
 * can't be judged by adherence, so past ones default to 'completed' rather
 * than always showing as 'missed' for having nothing to check off.
 */
function computeMilestoneStatus(milestone, adherenceEntry, today = startOfTodayUTC()) {
  const milestoneDate = new Date(milestone.date);
  const mKey = dateKeyUTC(milestoneDate);
  const todayKey = dateKeyUTC(today);

  if (mKey === todayKey) return 'active';
  if (milestoneDate > today) return 'upcoming';

  const tasksTotal = adherenceEntry?.tasksTotal ?? 0;
  if (tasksTotal === 0) return 'completed';
  const adherence = adherenceEntry?.adherence ?? 0;
  return adherence >= ADHERENCE_COMPLETE_THRESHOLD ? 'completed' : 'missed';
}

/**
 * Consecutive daily milestones ending today or yesterday with adherence
 * >= 0.6. If today hasn't reached the threshold yet (it may still be in
 * progress), counting starts from yesterday instead of breaking the streak
 * on an incomplete-but-not-yet-failed today.
 */
async function computeGoalStreak(patientId, today = startOfTodayUTC()) {
  const goal = await Goal.findOne({ patientId, status: 'active' });
  if (!goal) return 0;

  const dailyMilestones = await Milestone.find({
    goalId: goal._id,
    type: 'daily',
    date: { $lte: today },
  })
    .sort({ date: -1 })
    .limit(60)
    .lean();

  if (dailyMilestones.length === 0) return 0;

  const adherenceMap = await computeAdherenceForMilestones(dailyMilestones.map((m) => m._id));

  let startIndex = 0;
  const mostRecent = dailyMilestones[0];
  if (dateKeyUTC(mostRecent.date) === dateKeyUTC(today)) {
    const todayAdherence = adherenceMap.get(mostRecent._id.toString())?.adherence ?? 0;
    if (todayAdherence < ADHERENCE_COMPLETE_THRESHOLD) {
      startIndex = 1;
    }
  }

  let streak = 0;
  for (let i = startIndex; i < dailyMilestones.length; i++) {
    const entry = adherenceMap.get(dailyMilestones[i]._id.toString());
    if ((entry?.adherence ?? 0) >= ADHERENCE_COMPLETE_THRESHOLD) {
      streak++;
    } else {
      break;
    }
  }
  return streak;
}

/**
 * Linear regression over the last 21 days of Progress.weight entries,
 * projected to goal.targetValue. Returns null when there's too little data
 * to fit a trend, the trend is flat, or the trend is moving away from the
 * target (all of which make a projected date meaningless rather than just
 * optimistic) - callers should treat null as "not enough signal yet", not
 * an error.
 */
async function predictedEndDate(goal) {
  const since = new Date(Date.now() - 21 * MS_PER_DAY);
  const entries = await Progress.find({
    patientId: goal.patientId,
    weight: { $ne: null },
    date: { $gte: since },
  })
    .sort({ date: 1 })
    .select('date weight')
    .lean();

  if (entries.length < 2) return null;

  const x0 = entries[0].date.getTime();
  const points = entries.map((e) => ({
    x: (e.date.getTime() - x0) / MS_PER_DAY,
    y: e.weight,
  }));

  const n = points.length;
  const sumX = points.reduce((s, p) => s + p.x, 0);
  const sumY = points.reduce((s, p) => s + p.y, 0);
  const sumXY = points.reduce((s, p) => s + p.x * p.y, 0);
  const sumXX = points.reduce((s, p) => s + p.x * p.x, 0);
  const denom = n * sumXX - sumX * sumX;
  if (denom === 0) return null; // all entries on the same day - no slope

  const slope = (n * sumXY - sumX * sumY) / denom; // kg per day
  const intercept = (sumY - slope * sumX) / n;
  if (slope === 0) return null;

  const daysFromFirst = (goal.targetValue - intercept) / slope;
  if (!Number.isFinite(daysFromFirst) || daysFromFirst < 0) return null;

  return new Date(x0 + daysFromFirst * MS_PER_DAY);
}

/**
 * Ties the above together into the TimelineStats shape the API contract
 * needs (see docs/goal-timeline response contract). Safe to call even when
 * the patient has no active goal - callers should treat a null `goal`
 * return as "nothing to show yet".
 */
async function computeGoalStats(patientId, today = startOfTodayUTC()) {
  const goal = await Goal.findOne({ patientId, status: 'active' });
  if (!goal) return { goal: null, stats: null };

  const weekAgo = new Date(today.getTime() - 6 * MS_PER_DAY);
  const thirtyDaysAgo = new Date(today.getTime() - 29 * MS_PER_DAY);

  const [goalStreak, weekMilestones, last30Milestones, predicted] = await Promise.all([
    computeGoalStreak(patientId, today),
    Milestone.find({ goalId: goal._id, type: 'daily', date: { $gte: weekAgo, $lte: today } })
      .select('date')
      .lean(),
    Milestone.find({
      goalId: goal._id,
      type: 'daily',
      date: { $gte: thirtyDaysAgo, $lte: today },
    })
      .select('date')
      .lean(),
    predictedEndDate(goal),
  ]);

  const weekAdherence = await computeAdherenceForMilestones(weekMilestones.map((m) => m._id));
  const weekDone = weekMilestones.filter(
    (m) => (weekAdherence.get(m._id.toString())?.adherence ?? 0) >= ADHERENCE_COMPLETE_THRESHOLD
  ).length;

  const last30Adherence = await computeAdherenceForMilestones(last30Milestones.map((m) => m._id));
  const adherenceValues = last30Milestones.map(
    (m) => last30Adherence.get(m._id.toString())?.adherence ?? 0
  );
  const adherence30d =
    adherenceValues.length === 0
      ? 0
      : Math.round((adherenceValues.reduce((s, v) => s + v, 0) / adherenceValues.length) * 100) /
        100;

  const daysToGo = Math.max(0, Math.round((goal.endDate.getTime() - today.getTime()) / MS_PER_DAY));
  const onPace = predicted ? predicted <= goal.endDate : null;

  return {
    goal,
    stats: {
      streak: goalStreak,
      weekDone,
      weekTotal: weekMilestones.length,
      adherence30d,
      daysToGo,
      predictedEndDate: predicted,
      onPace,
    },
  };
}

module.exports = {
  ADHERENCE_COMPLETE_THRESHOLD,
  computeAdherenceForMilestones,
  computeMilestoneStatus,
  computeGoalStreak,
  predictedEndDate,
  computeGoalStats,
};
