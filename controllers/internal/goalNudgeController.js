const { Goal, Notification, User, Progress } = require('../../models');
const { enqueue } = require('../../utils/jobQueue');

/**
 * Direction-agnostic 0..1 progress toward a goal's target - matches the
 * exact formula both Flutter apps' GoalDto.progress already use, so "did
 * they reach it" here can never disagree with what the timeline UI shows.
 */
function computeProgress(startValue, currentValue, targetValue) {
  if (startValue === targetValue) return 0;
  const value = (startValue - currentValue) / (startValue - targetValue);
  return Math.max(0, Math.min(1, value));
}

/**
 * Daily sweep (see routes/internal.js): finds active goals whose endDate has
 * passed without the patient reaching targetValue, and haven't already been
 * nudged for this miss (nudgeSentAt, stamped once and never reset - unlike
 * the renewal reminder, a goal doesn't get a fresh window on any kind of
 * renewal, so one nudge per goal is correct). Nudges to continue the diet
 * journey and rebook their subscription, via an in-app Notification plus a
 * best-effort real push - same "DB write always happens, push/socket are
 * independently best-effort" convention as
 * controllers/dietician/timelineController.js::createNudge.
 *
 * Uses the patient's latest logged Progress.weight (not goal.currentValue,
 * which nothing in this codebase keeps in sync after goal creation) as the
 * most-recent-truth signal, same source predictedEndDate() in
 * utils/goalAdherence.js already relies on.
 */
async function runGoalNudgeSweep({ now = new Date() } = {}) {
  const candidates = await Goal.find({
    status: 'active',
    endDate: { $lt: now },
    nudgeSentAt: null,
  }).lean();
  if (candidates.length === 0) return { checked: 0, created: 0 };

  // Cross-app performance optimization, Phase 2/3: the latest-Progress lookup
  // and the device-token lookup were one query per goal inside the loop, and
  // each goal was saved individually. Batch all three.
  const patientIds = [...new Set(candidates.map((g) => g.patientId.toString()))];

  // Latest logged weight per patient (query sorted newest-first, keep the
  // first row seen for each patient).
  const progressRows = await Progress.find({
    patientId: { $in: patientIds },
    weight: { $ne: null },
  })
    .sort({ date: -1 })
    .select('patientId weight')
    .lean();
  const latestWeightByPatient = new Map();
  for (const row of progressRows) {
    const key = row.patientId.toString();
    if (!latestWeightByPatient.has(key)) latestWeightByPatient.set(key, row.weight);
  }

  const toNudge = candidates.filter((goal) => {
    const currentValue =
      latestWeightByPatient.get(goal.patientId.toString()) ??
      goal.currentValue ??
      goal.startValue;
    // progress >= 1 means the target was reached after all (Progress caught
    // up after endDate) - nothing to nudge about, just stamp it below.
    return computeProgress(goal.startValue, currentValue, goal.targetValue) < 1;
  });

  if (toNudge.length > 0) {
    await Notification.insertMany(
      toNudge.map((goal) => ({
        userId: goal.patientId,
        title: "Let's get back on track",
        message: `You're close to reaching "${goal.title}" - don't stop now. Continue your diet journey and rebook your subscription to keep going.`,
        type: 'milestone',
        referenceId: goal._id,
        referenceModel: 'Goal',
      })),
      { ordered: false }
    );

    const nudgePatientIds = [...new Set(toNudge.map((g) => g.patientId.toString()))];
    const patients = await User.find({ _id: { $in: nudgePatientIds } })
      .select('_id deviceTokens')
      .lean();
    const tokensByPatient = new Map(
      patients.map((p) => [p._id.toString(), (p.deviceTokens || []).map((t) => t.token)])
    );

    // Hand each recipient's push to the async job queue (Phase 3, task 3.4).
    // Without REDIS_URL `enqueue` runs the send inline here - same as before.
    for (const goal of toNudge) {
      const pid = goal.patientId.toString();
      const tokens = tokensByPatient.get(pid) || [];
      if (tokens.length === 0) continue;
      await enqueue('push', {
        patientId: pid,
        tokens,
        notification: {
          title: "Let's get back on track",
          body: `Continue your diet journey and rebook your subscription to reach "${goal.title}".`,
          data: { deepLink: 'docwellness://timeline', goalId: String(goal._id) },
        },
      });
    }
  }

  // Stamp every candidate (nudged or already-reached) so none is reconsidered.
  await Goal.updateMany(
    { _id: { $in: candidates.map((g) => g._id) } },
    { $set: { nudgeSentAt: now } }
  );

  return { checked: candidates.length, created: toNudge.length };
}

module.exports = { runGoalNudgeSweep, computeProgress };
