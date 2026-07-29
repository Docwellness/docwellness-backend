// Shared timeline response-shaping - used by both
// controllers/patient/timelineController.js (own timeline) and
// controllers/dietician/timelineController.js (a specific patient's
// timeline), so the two never silently diverge in shape.

const { Milestone, MilestoneTask, CheckIn } = require('../models');
const {
  computeGoalStats,
  computeAdherenceForMilestones,
  computeMilestoneStatus,
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
  const [adherenceMap, tasks, checkIns] = await Promise.all([
    computeAdherenceForMilestones(milestoneIds),
    MilestoneTask.find({ milestoneId: { $in: milestoneIds } }).sort({ sortOrder: 1 }).lean(),
    CheckIn.find({ milestoneId: { $in: milestoneIds } }).select('taskId').lean(),
  ]);

  const doneTaskIds = new Set(checkIns.map((c) => c.taskId.toString()));
  const tasksByMilestone = new Map();
  for (const t of tasks) {
    const key = t.milestoneId.toString();
    if (!tasksByMilestone.has(key)) tasksByMilestone.set(key, []);
    tasksByMilestone.get(key).push({
      id: t._id,
      title: t.title,
      metric: t.metric,
      icon: t.icon,
      done: doneTaskIds.has(t._id.toString()),
    });
  }

  const shapedMilestones = milestones.map((m) => {
    const adherenceEntry = adherenceMap.get(m._id.toString());
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

module.exports = { buildTimelinePayload, shapeGoal, parseRangeParam };
