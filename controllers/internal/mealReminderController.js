const { DietPlan, MealLog, User, Notification } = require('../../models');
const { resolveDayGroupForDate, mealMatchesDayGroup } = require('../../utils/dayGroups');
const { resolveCurrentWeek } = require('../../utils/dietPlanWeek');
const { sendPushToTokens } = require('../../utils/push');

const normalizeDate = (dateObj) =>
  new Date(Date.UTC(dateObj.getUTCFullYear(), dateObj.getUTCMonth(), dateObj.getUTCDate()));

const dayKeyFor = (dateObj) => {
  const year = dateObj.getUTCFullYear();
  const month = String(dateObj.getUTCMonth() + 1).padStart(2, '0');
  const day = String(dateObj.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

/**
 * Fixed-time meal reminder (see vercel.json's one cron entry per servingTime,
 * each ~30min ahead of that slot's typical eating time) - for every patient
 * with an active diet plan that includes `slot` in today's day-group, and
 * who hasn't logged that slot yet today, sends an in-app Notification plus a
 * best-effort real push. Fixed-schedule by design (not adaptive to how long
 * ago the patient last logged anything) - same "DB write always happens,
 * push is independently best-effort" convention as every other cron sweep
 * in this codebase (see renewalReminderController.js/goalNudgeController.js).
 *
 * `now` is injectable so tests can simulate a specific point in time.
 */
async function runMealReminderSweep({ slot, now = new Date() } = {}) {
  if (!slot) return { checked: 0, notified: 0 };

  const today = normalizeDate(now);
  const dayKey = dayKeyFor(today);
  const todayDayGroup = resolveDayGroupForDate(today);
  const todayStart = new Date(dayKey);
  const todayEnd = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000);

  const activePlans = await DietPlan.find({ status: 'Active' })
    .select('patientId finalizedPlan.weeks weekSchedule activationDate request')
    .populate('request', 'startDateForDiet')
    .lean();

  let notified = 0;
  for (const plan of activePlans) {
    const weeks = Array.isArray(plan.finalizedPlan?.weeks) ? plan.finalizedPlan.weeks : [];
    const currentWeek = resolveCurrentWeek(plan, today);
    const week = weeks.find((w) => Number(w.week) === Number(currentWeek));
    if (!week) continue;

    const hasSlotToday = (week.dailyMeals || []).some(
      (meal) => meal.servingTime === slot && mealMatchesDayGroup(meal, todayDayGroup)
    );
    if (!hasSlotToday) continue;

    const existingLog = await MealLog.findOne({ patientId: plan.patientId, dayKey })
      .select('meals')
      .lean();
    const alreadyLogged = (existingLog?.meals || []).some((m) => m.servingTime === slot);
    if (alreadyLogged) continue;

    const title = `Time for ${slot}`;
    const message = `Don't forget to log your ${slot} once you've had it.`;

    // Idempotency guard - a manual re-trigger of the same cron route within
    // the same day/slot must not double-notify (referenceId can't hold a
    // composite "date:slot" key - it's a strict ObjectId ref - so dedupe on
    // title+day instead).
    const already = await Notification.findOne({
      userId: plan.patientId,
      type: 'meal_reminder',
      title,
      createdAt: { $gte: todayStart, $lt: todayEnd },
    })
      .select('_id')
      .lean();
    if (already) continue;

    await Notification.create({
      userId: plan.patientId,
      title,
      message,
      type: 'meal_reminder',
    });

    const patient = await User.findById(plan.patientId).select('deviceTokens').lean();
    const tokens = (patient?.deviceTokens || []).map((t) => t.token);
    await sendPushToTokens(
      tokens,
      {
        title,
        body: message,
        data: { deepLink: 'docwellness://timeline', servingTime: slot },
      },
      (deadToken) => {
        User.updateOne({ _id: plan.patientId }, { $pull: { deviceTokens: { token: deadToken } } }).catch(
          () => {}
        );
      }
    ).catch((err) => console.error('[mealReminder] push failed (non-fatal):', err.message));

    notified += 1;
  }

  return { checked: activePlans.length, notified };
}

module.exports = { runMealReminderSweep };
