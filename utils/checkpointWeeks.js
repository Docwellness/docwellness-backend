/**
 * One canonical week number for a goal's weekly checkpoints: the number the
 * patient sees on the Diet screen, (plan cycleNumber - 1) * 4 + the
 * checkpoint's position inside its cycle. It does not restart on renewal.
 *
 * Progress.week entries saved before weekBasis existed hold only the position
 * inside the cycle that was current when they were written; they are
 * translated on read (displayWeekForLegacyEntry), never rewritten.
 */

const { Milestone, DietPlan, Goal } = require('../models');
const { resolvePlanStartDate } = require('./seedGoalTimeline');

const WEEKS_PER_CYCLE = 4;

/** [{ cycleNumber, start }] for the patient's non-Draft plans, oldest start first. */
function buildCycles(plans) {
  return (plans || [])
    .filter((p) => p && p.status !== 'Draft')
    .map((p) => ({ cycleNumber: p.cycleNumber || 1, start: resolvePlanStartDate(p) }))
    .filter((c) => c.start)
    .sort((a, b) => a.start - b.start || a.cycleNumber - b.cycleNumber);
}

/** The cycle with the greatest start on or before `date`, or null before the first one. */
function cycleAt(cycles, date) {
  const t = new Date(date).getTime();
  let found = null;
  for (const c of cycles) {
    if (c.start.getTime() <= t) found = c;
    else break;
  }
  return found;
}

/**
 * Weekly checkpoints of a goal as [{ id, date, displayWeek, cycleNumber,
 * indexInCycle }], in date order. Milestones before the first plan start are
 * excluded. `milestones` (weekly docs with _id and date) may be passed in;
 * otherwise they are loaded for `goalId`.
 */
async function buildCheckpointWeeks({ goalId, plans, milestones }) {
  const docs =
    milestones ||
    (await Milestone.find({ goalId, type: 'weekly' }).sort({ date: 1 }).select('_id date').lean());
  const cycles = buildCycles(plans);
  const countByCycle = new Map();
  const result = [];
  const sorted = [...docs].sort((a, b) => new Date(a.date) - new Date(b.date));
  for (const m of sorted) {
    const cycle = cycleAt(cycles, m.date);
    if (!cycle) continue;
    const indexInCycle = (countByCycle.get(cycle.cycleNumber) || 0) + 1;
    countByCycle.set(cycle.cycleNumber, indexInCycle);
    result.push({
      id: String(m._id),
      date: m.date,
      displayWeek: (cycle.cycleNumber - 1) * WEEKS_PER_CYCLE + indexInCycle,
      cycleNumber: cycle.cycleNumber,
      indexInCycle,
    });
  }
  return result;
}

/**
 * Canonical week of a Progress entry that carries `week`, or null when it has
 * none. Entries tagged weekBasis 'display' already hold it; older ones are
 * offset by the cycle they were logged in (cycle 1 when before every start).
 */
function displayWeekForLegacyEntry(entry, cycles) {
  if (!entry || !entry.week) return null;
  if (entry.weekBasis === 'display') return entry.week;
  const cycle = cycleAt(cycles, entry.date);
  return ((cycle ? cycle.cycleNumber : 1) - 1) * WEEKS_PER_CYCLE + entry.week;
}

/** Plans, cycles and checkpoints for a patient's goal, loaded once for a request. */
async function loadCheckpointWeeks(patientId, goalId) {
  const plans = await DietPlan.find({ patientId, status: { $ne: 'Draft' } })
    .select('status cycleNumber weekSchedule activationDate startDate')
    .lean();
  const cycles = buildCycles(plans);
  const checkpoints = goalId ? await buildCheckpointWeeks({ goalId, plans }) : [];
  return { plans, cycles, checkpoints };
}

/** Same as loadCheckpointWeeks, resolving the patient's active goal first. */
async function loadActiveGoalCheckpointWeeks(patientId) {
  const goal = await Goal.findOne({ patientId, status: 'active' }).select('_id').lean();
  return { goalId: goal?._id || null, ...(await loadCheckpointWeeks(patientId, goal?._id)) };
}

module.exports = {
  WEEKS_PER_CYCLE,
  buildCycles,
  cycleAt,
  buildCheckpointWeeks,
  displayWeekForLegacyEntry,
  loadCheckpointWeeks,
  loadActiveGoalCheckpointWeeks,
};
