const { DietPlan, User, Notification } = require('../../models');
const WaterLog = require('../../models/WaterLog');
const { enqueue } = require('../../utils/jobQueue');

/**
 * Fixed-time water reminder (see vercel.json's 4 checkpoints spread across
 * the day) - for every patient with an active diet plan whose today's
 * WaterLog total is still below goal at this checkpoint, sends an in-app
 * Notification plus a best-effort real push. Fixed-schedule by design (not
 * adaptive to time-since-last-log) - same convention as
 * mealReminderController.js. Skips patients who've already hit their goal so
 * this doesn't nag once the day's target is met.
 *
 * WaterLog.date is a plain "yyyy-MM-dd" string (unlike MealLog's Date field -
 * see models/WaterLog.js), built from `now`'s UTC calendar date to match how
 * the patient app's own sync already stamps entries (see
 * WaterController._today in the Flutter app).
 *
 * `now` is injectable so tests can simulate a specific point in time.
 */
async function runWaterReminderSweep({ checkpoint, now = new Date() } = {}) {
  const dateStr = now.toISOString().split('T')[0];
  // Dedupe window scoped to "this checkpoint's own run" (not the whole day -
  // checkpoints are ~3 hours apart and each one is meant to fire), so only a
  // genuine double-trigger of the same checkpoint (e.g. a manual re-run
  // minutes later) is suppressed, not the next scheduled checkpoint.
  const dedupeWindowStart = new Date(now.getTime() - 60 * 60 * 1000);

  const activePatientIds = await DietPlan.find({ status: 'Active' }).distinct('patientId');
  if (activePatientIds.length === 0) return { checked: 0, notified: 0 };

  const waterLogs = await WaterLog.find({ patientId: { $in: activePatientIds }, date: dateStr })
    .select('patientId totalAmount goal')
    .lean();
  const waterLogByPatient = new Map(waterLogs.map((w) => [w.patientId.toString(), w]));

  const title = 'Stay hydrated';

  // Patients still short of today's goal at this checkpoint, keyed to the
  // message tailored to how much they have left.
  const shortfall = new Map(); // patientId string -> message
  for (const patientId of activePatientIds) {
    const log = waterLogByPatient.get(patientId.toString());
    const totalAmount = log?.totalAmount || 0;
    const goal = log?.goal || 2500;
    if (totalAmount >= goal) continue;
    const remainingLiters = ((goal - totalAmount) / 1000).toFixed(1);
    shortfall.set(
      patientId.toString(),
      `You've got ${remainingLiters}L left to reach today's water goal.`
    );
  }
  if (shortfall.size === 0) return { checked: activePatientIds.length, notified: 0 };

  // Cross-app performance optimization, Phase 2/3: the dedupe check and the
  // device-token lookup were one query per patient inside the loop - batch
  // both. Dedupe within this checkpoint's own run window so a manual
  // re-trigger can't double-notify the same patient for the same checkpoint.
  const shortfallIds = [...shortfall.keys()];
  const alreadyNotified = new Set(
    (
      await Notification.find({
        userId: { $in: shortfallIds },
        type: 'water_reminder',
        title,
        createdAt: { $gte: dedupeWindowStart },
      })
        .select('userId')
        .lean()
    ).map((n) => n.userId.toString())
  );

  const toNotify = shortfallIds.filter((id) => !alreadyNotified.has(id));
  if (toNotify.length === 0) return { checked: activePatientIds.length, notified: 0 };

  await Notification.insertMany(
    toNotify.map((pid) => ({
      userId: pid,
      title,
      message: shortfall.get(pid),
      type: 'water_reminder',
    })),
    { ordered: false }
  );

  const patients = await User.find({ _id: { $in: toNotify } })
    .select('_id deviceTokens')
    .lean();
  const tokensByPatient = new Map(
    patients.map((p) => [p._id.toString(), (p.deviceTokens || []).map((t) => t.token)])
  );

  // Hand each recipient's push to the async job queue (Phase 3, task 3.4).
  // Without REDIS_URL `enqueue` runs the send inline here - same as before.
  let queued = 0;
  for (const pid of toNotify) {
    const tokens = tokensByPatient.get(pid) || [];
    if (tokens.length === 0) continue;
    await enqueue('push', {
      patientId: pid,
      tokens,
      notification: {
        title,
        body: shortfall.get(pid),
        data: { deepLink: 'docwellness://timeline', checkpoint: checkpoint || '' },
      },
    });
    queued += 1;
  }

  return { checked: activePatientIds.length, notified: toNotify.length, pushQueued: queued };
}

module.exports = { runWaterReminderSweep };
