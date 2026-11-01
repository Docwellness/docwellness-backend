const { Goal } = require('../models');
const { loadCheckpointWeeks } = require('./checkpointWeeks');

/**
 * The goal's weekly checkpoints on the patient's visible timeline, in order,
 * as [{ id, date, weekNumber }]. weekNumber is the canonical display week
 * (see utils/checkpointWeeks.js): (cycleNumber - 1) * 4 + position in the
 * cycle, so it does not restart on renewal and matches the Diet screen. This
 * is the number Progress.week is tagged with (Log My Body).
 */
async function weeklyCheckpoints(goalId, planStart) {
  const goal = await Goal.findById(goalId).select('patientId').lean();
  if (!goal) return [];
  const { checkpoints } = await loadCheckpointWeeks(goal.patientId, goalId);
  const startMs = planStart ? new Date(planStart).setUTCHours(0, 0, 0, 0) : null;
  return checkpoints
    .filter((c) => startMs === null || new Date(c.date).getTime() >= startMs)
    .map((c) => ({ id: c.id, date: c.date, weekNumber: c.displayWeek }));
}

module.exports = { weeklyCheckpoints };
