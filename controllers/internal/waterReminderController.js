const { DietPlan, User, Notification } = require('../../models');
const WaterLog = require('../../models/WaterLog');
const { sendPushToTokens } = require('../../utils/push');

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

  let notified = 0;
  for (const patientId of activePatientIds) {
    const log = waterLogByPatient.get(patientId.toString());
    const totalAmount = log?.totalAmount || 0;
    const goal = log?.goal || 2500;
    if (totalAmount >= goal) continue;

    const remainingLiters = ((goal - totalAmount) / 1000).toFixed(1);
    const message = `You've got ${remainingLiters}L left to reach today's water goal.`;

    // Dedupe within this checkpoint's own run window - a manual re-trigger
    // must not double-notify the same patient for the same checkpoint.
    const already = await Notification.findOne({
      userId: patientId,
      type: 'water_reminder',
      title,
      createdAt: { $gte: dedupeWindowStart },
    })
      .select('_id')
      .lean();
    if (already) continue;

    await Notification.create({
      userId: patientId,
      title,
      message,
      type: 'water_reminder',
    });

    const patient = await User.findById(patientId).select('deviceTokens').lean();
    const tokens = (patient?.deviceTokens || []).map((t) => t.token);
    await sendPushToTokens(
      tokens,
      {
        title,
        body: message,
        data: { deepLink: 'docwellness://timeline', checkpoint: checkpoint || '' },
      },
      (deadToken) => {
        User.updateOne({ _id: patientId }, { $pull: { deviceTokens: { token: deadToken } } }).catch(() => {});
      }
    ).catch((err) => console.error('[waterReminder] push failed (non-fatal):', err.message));

    notified += 1;
  }

  return { checked: activePatientIds.length, notified };
}

module.exports = { runWaterReminderSweep };
