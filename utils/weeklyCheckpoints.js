const { Milestone } = require('../models');

/**
 * The goal's weekly checkpoints on the patient's visible timeline, in order,
 * as [{ id, date, weekNumber }]. weekNumber is the 1-based position among the
 * weekly milestones that fall on/after the plan start - the first checkpoint
 * the patient actually sees is Week 1 here. This is the number Progress.week
 * is tagged with (Log My Body), kept stable here instead of derived from
 * whichever slice of the timeline the client happened to fetch.
 */
async function weeklyCheckpoints(goalId, planStart) {
  const docs = await Milestone.find({ goalId, type: 'weekly' })
    .sort({ date: 1 })
    .select('_id date')
    .lean();
  const startMs = planStart ? new Date(planStart).setUTCHours(0, 0, 0, 0) : null;
  return docs
    .filter((m) => startMs === null || new Date(m.date).getTime() >= startMs)
    .map((m, i) => ({ id: m._id.toString(), date: m.date, weekNumber: i + 1 }));
}

module.exports = { weeklyCheckpoints };
