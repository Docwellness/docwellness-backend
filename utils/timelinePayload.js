// Shared timeline response-shaping - used by both
// controllers/patient/timelineController.js (own timeline) and
// controllers/dietician/timelineController.js (a specific patient's
// timeline), so the two never silently diverge in shape.

const { Milestone, MilestoneTask, MealLog, Progress } = require('../models');
const {
  computeGoalStats,
  computeAdherenceForMilestones,
  computeMilestoneStatus,
  computeTaskDoneMap,
} = require('./goalAdherence');

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function shapeGoal(goal) {
  return {
    id: goal._id,
    title: goal.title,
    metric: goal.metric,
    startValue: goal.startValue,
    currentValue: goal.currentValue,
    targetValue: goal.targetValue,
    unit: goal.unit,
    startDate: goal.startDate,
    endDate: goal.endDate,
    status: goal.status,
  };
}

function parseRangeParam(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Builds the full { goal, stats, milestones } payload for a patient,
 * windowed to [today+fromDays, today+toDays] (fromDays is typically
 * negative - "14 days ago"). Returns { goal: null, stats: null,
 * milestones: [] } when the patient has no active goal yet.
 */
async function buildTimelinePayload(patientId, { from = -14, to = 30 } = {}) {
  const { goal, stats } = await computeGoalStats(patientId);
  if (!goal) return { goal: null, stats: null, milestones: [] };

  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const fromDays = parseRangeParam(from, -14);
  const toDays = parseRangeParam(to, 30);
  const rangeStart = new Date(today.getTime() + fromDays * MS_PER_DAY);
  const rangeEnd = new Date(today.getTime() + toDays * MS_PER_DAY);

  const milestones = await Milestone.find({
    goalId: goal._id,
    date: { $gte: rangeStart, $lte: rangeEnd },
  })
    .sort({ date: 1, sortOrder: 1 })
    .lean();

  const milestoneIds = milestones.map((m) => m._id);
  const [adherenceMap, tasks, taskDoneMap] = await Promise.all([
    computeAdherenceForMilestones(patientId, milestoneIds, milestones),
    MilestoneTask.find({ milestoneId: { $in: milestoneIds } }).sort({ sortOrder: 1 }).lean(),
    computeTaskDoneMap(patientId, milestones),
  ]);

  const tasksByMilestone = new Map();
  for (const t of tasks) {
    const key = t.milestoneId.toString();
    if (!tasksByMilestone.has(key)) tasksByMilestone.set(key, []);
    const info = taskDoneMap.get(t._id.toString()) || {
      done: false,
      linked: false,
      loggedNote: null,
      progress: null,
    };
    tasksByMilestone.get(key).push({
      id: t._id,
      title: t.title,
      metric: t.metric,
      icon: t.icon,
      linked: info.linked,
      done: info.done,
      loggedNote: info.loggedNote,
      progress: info.progress,
    });
  }

  // A 'weekly' milestone has no MilestoneTask docs of its own (only 'daily'
  // milestones get default tasks - see seedGoalTimeline.js), so
  // adherenceMap always holds tasksTotal: 0 for it, which made
  // computeMilestoneStatus fall back to its "no tasks -> completed" case -
  // every past week's checkpoint showed a checkmark unconditionally,
  // whether or not the patient actually completed that week's daily tasks.
  // Build a real adherence for a weekly milestone instead, aggregated from
  // the 7 'daily' milestones spanning that week (weekEnd-6..weekEnd, since
  // seedGoalTimeline now dates a weekly milestone on the week's LAST day -
  // same window convention as computeGoalStats' own 7-day rollup above).
  const dailyMilestones = milestones.filter((m) => m.type === 'daily');
  function weeklyAdherenceEntry(weeklyMilestone) {
    const weekEnd = new Date(weeklyMilestone.date);
    const weekStart = new Date(weekEnd.getTime() - 6 * MS_PER_DAY);
    const daysInWeek = dailyMilestones.filter((d) => d.date >= weekStart && d.date <= weekEnd);
    if (daysInWeek.length === 0) return adherenceMap.get(weeklyMilestone._id.toString());

    let tasksTotal = 0;
    let tasksDone = 0;
    for (const day of daysInWeek) {
      const entry = adherenceMap.get(day._id.toString());
      tasksTotal += entry?.tasksTotal ?? 0;
      tasksDone += entry?.tasksDone ?? 0;
    }
    return { tasksTotal, tasksDone, adherence: tasksTotal === 0 ? 0 : tasksDone / tasksTotal };
  }

  const shapedMilestones = milestones.map((m) => {
    const adherenceEntry =
      m.type === 'weekly' ? weeklyAdherenceEntry(m) : adherenceMap.get(m._id.toString());
    return {
      id: m._id,
      type: m.type,
      title: m.title,
      subtitle: m.subtitle,
      date: m.date,
      status: computeMilestoneStatus(m, adherenceEntry, today),
      adherence: adherenceEntry?.adherence ?? 0,
      tasks: tasksByMilestone.get(m._id.toString()) || [],
    };
  });

  return { goal: shapeGoal(goal), stats, milestones: shapedMilestones };
}

/**
 * What a patient actually logged on a given day (meals + weight/measurements)
 * - reads existing MealLog/Progress, no new storage. Shared by both the
 * patient's own "what did I log" view and the dietician's day-logs sheet.
 */
async function getDayLogs(patientId, dateStr) {
  const day = new Date(dateStr);
  if (Number.isNaN(day.getTime())) return null;

  const dayStart = new Date(day);
  dayStart.setUTCHours(0, 0, 0, 0);
  const dayEnd = new Date(day);
  dayEnd.setUTCHours(23, 59, 59, 999);

  const [mealLog, progressEntries] = await Promise.all([
    MealLog.findOne({ patientId, date: { $gte: dayStart, $lte: dayEnd } }).lean(),
    Progress.find({ patientId, date: { $gte: dayStart, $lte: dayEnd } }).lean(),
  ]);

  return {
    meals: mealLog?.meals || [],
    progress: progressEntries,
  };
}

module.exports = { buildTimelinePayload, shapeGoal, parseRangeParam, getDayLogs };
