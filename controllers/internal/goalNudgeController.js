const { Goal, Notification, User, Progress } = require('../../models');
const { sendPushToTokens } = require('../../utils/push');

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
  });

  let created = 0;
  for (const goal of candidates) {
    const latestProgress = await Progress.findOne({ patientId: goal.patientId, weight: { $ne: null } })
      .sort({ date: -1 })
      .select('weight');
    const currentValue = latestProgress?.weight ?? goal.currentValue ?? goal.startValue;
    const progress = computeProgress(goal.startValue, currentValue, goal.targetValue);

    if (progress >= 1) {
      // Reached the target after all (Progress caught up after endDate) -
      // nothing to nudge about; stop the sweep from reconsidering it daily.
      goal.nudgeSentAt = now;
      await goal.save();
      continue;
    }

    await Notification.create({
      userId: goal.patientId,
      title: "Let's get back on track",
      message: `You're close to reaching "${goal.title}" - don't stop now. Continue your diet journey and rebook your subscription to keep going.`,
      type: 'milestone',
      referenceId: goal._id,
      referenceModel: 'Goal',
    });

    const patient = await User.findById(goal.patientId).select('deviceTokens').lean();
    const tokens = (patient?.deviceTokens || []).map((t) => t.token);
    await sendPushToTokens(
      tokens,
      {
        title: "Let's get back on track",
        body: `Continue your diet journey and rebook your subscription to reach "${goal.title}".`,
        data: { deepLink: 'docwellness://timeline', goalId: String(goal._id) },
      },
      (deadToken) => {
        User.updateOne({ _id: goal.patientId }, { $pull: { deviceTokens: { token: deadToken } } }).catch(
          () => {}
        );
      }
    ).catch((err) => console.error('[goalNudge] push failed (non-fatal):', err.message));

    goal.nudgeSentAt = now;
    await goal.save();
    created += 1;
  }

  return { checked: candidates.length, created };
}

module.exports = { runGoalNudgeSweep, computeProgress };
