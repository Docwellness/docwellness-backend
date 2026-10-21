const { User, DietPlanRequest, Notification } = require('../../models');
const { enqueue } = require('../../utils/jobQueue');
const { loadRule, render } = require('../../utils/notificationRules');

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// A person's first nudges come every 2 days, then it settles to weekly. The
// small slack (2h) keeps a cron that runs a little late from skipping a day.
const EARLY_NUDGES = 6;
const EARLY_GAP = 2 * DAY - 2 * HOUR;
const LATER_GAP = 7 * DAY - 2 * HOUR;
// Someone who only just signed up is still finding their way around.
const MIN_ACCOUNT_AGE = DAY;

// primaryGoal -> a phrase that reads naturally after "to" / "help you".
const GOAL_PHRASE = {
  'Weight Loss': 'lose weight',
  'Weight Gain': 'gain weight',
  'Weight Maintenance': 'maintain your weight',
  'Muscle Gain (Body Recomposition)': 'build muscle',
  'Fat Loss': 'lose fat',
  'Healthy Weight Management': 'manage your weight healthily',
};
const FALLBACK_GOAL = 'feel your best';

const firstName = (full) => String(full || '').trim().split(/\s+/)[0] || 'there';

/**
 * Daily sweep (see routes/internal.js): encourages people who signed up but
 * have not requested a diet plan to do so. Each person is sent the next
 * wording in the rule's list after the one they last received, so the text
 * keeps changing and never repeats back to back. The in-app Notification is
 * always written, so they see it in the bell list even with push off; the
 * push is handed to the job queue on top of that.
 *
 * Who qualifies: an active patient, signed up at least a day ago, who has
 * never subscribed and has never sent a diet plan request. Once they request
 * a plan they drop out, since nothing here is left to ask of them. Whether
 * they are due is worked out from their own notification history, so a
 * second run the same day sends nothing new.
 *
 * `now` is injectable so tests can simulate a specific point in time.
 */
async function runRequestPlanNudgeSweep({ now = new Date() } = {}) {
  const rule = await loadRule('request_plan_nudge');
  if (!rule.enabled) return { checked: 0, notified: 0, disabled: true };

  const candidates = await User.find({
    role: 'patient',
    isActive: { $ne: false },
    createdAt: { $lte: new Date(now.getTime() - MIN_ACCOUNT_AGE) },
    $or: [{ 'status.subscriptionExpiresAt': null }, { 'status.subscriptionExpiresAt': { $exists: false } }],
  })
    .select('_id createdAt profile.fullName healthProfile.primaryGoal deviceTokens')
    .lean();
  if (candidates.length === 0) return { checked: 0, notified: 0 };

  const ids = candidates.map((u) => u._id);
  const [requesters, history] = await Promise.all([
    DietPlanRequest.distinct('patient', { patient: { $in: ids } }),
    Notification.aggregate([
      { $match: { type: 'diet_plan_nudge', userId: { $in: ids } } },
      { $group: { _id: '$userId', sent: { $sum: 1 }, last: { $max: '$createdAt' } } },
    ]),
  ]);
  const hasRequested = new Set(requesters.map(String));
  const sentBefore = new Map(history.map((h) => [String(h._id), h]));

  const variants = rule.variants;
  const due = [];
  for (const user of candidates) {
    const id = String(user._id);
    if (hasRequested.has(id)) continue;
    const past = sentBefore.get(id);
    const sent = past?.sent || 0;
    const gap = sent < EARLY_NUDGES ? EARLY_GAP : LATER_GAP;
    if (past && now.getTime() - new Date(past.last).getTime() < gap) continue;

    const vars = {
      name: firstName(user.profile?.fullName),
      goal: GOAL_PHRASE[user.healthProfile?.primaryGoal] || FALLBACK_GOAL,
      days: Math.max(1, Math.floor((now.getTime() - new Date(user.createdAt).getTime()) / DAY)),
    };
    const variant = variants[sent % variants.length];
    due.push({ user, title: render(variant.title, vars), message: render(variant.message, vars) });
  }
  if (due.length === 0) return { checked: candidates.length, notified: 0 };

  await Notification.insertMany(
    due.map((d) => ({
      userId: d.user._id,
      title: d.title,
      message: d.message,
      type: 'diet_plan_nudge',
    })),
    { ordered: false }
  );

  let queued = 0;
  for (const d of due) {
    const tokens = (d.user.deviceTokens || []).map((t) => t.token);
    if (tokens.length === 0) continue;
    await enqueue('push', {
      patientId: String(d.user._id),
      tokens,
      notification: { title: d.title, body: d.message, data: { deepLink: 'docwellness://request-plan' } },
    });
    queued += 1;
  }

  return { checked: candidates.length, notified: due.length, pushQueued: queued };
}

module.exports = { runRequestPlanNudgeSweep };
