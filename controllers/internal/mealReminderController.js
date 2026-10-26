const {
  DietPlan,
  DayPlan,
  MealSlotPlan,
  PlanItem,
  MealLog,
  User,
  Notification,
} = require('../../models');
const { resolveDayGroupForDate, mealMatchesDayGroup } = require('../../utils/dayGroups');
const { resolveCurrentWeek } = require('../../utils/dietPlanWeek');
const { getFinalizedWeeks } = require('../../utils/dietPlanLegacyView');
const { enqueue } = require('../../utils/jobQueue');
const { loadRule, render } = require('../../utils/notificationRules');

const normalizeDate = (dateObj) =>
  new Date(Date.UTC(dateObj.getUTCFullYear(), dateObj.getUTCMonth(), dateObj.getUTCDate()));

const dayKeyFor = (dateObj) => {
  const year = dateObj.getUTCFullYear();
  const month = String(dateObj.getUTCMonth() + 1).padStart(2, '0');
  const day = String(dateObj.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

/**
 * Which of the given plan-item (v4.0) plans have `slot` on their current
 * week's `dayGroup`. Those plans keep their meals in DayPlan/MealSlotPlan/
 * PlanItem, not in finalizedPlan.weeks, so getFinalizedWeeks() sees them as
 * empty - three batched queries cover every such plan, rather than building
 * each patient's full plan view. Returns a Set of DietPlan id strings.
 */
async function planItemPlanIdsWithSlot(plans, slot, dayGroup, today) {
  if (plans.length === 0) return new Set();
  const currentWeekByPlan = new Map(
    plans.map((plan) => [String(plan._id), Number(resolveCurrentWeek(plan, today))])
  );

  const dayPlans = await DayPlan.find({
    dietPlanId: { $in: plans.map((p) => p._id) },
    dayGroup,
  })
    .select('dietPlanId week')
    .lean();
  const dayPlanPlanId = new Map();
  for (const dp of dayPlans) {
    if (Number(dp.week) === currentWeekByPlan.get(String(dp.dietPlanId))) {
      dayPlanPlanId.set(String(dp._id), String(dp.dietPlanId));
    }
  }
  if (dayPlanPlanId.size === 0) return new Set();

  const slots = await MealSlotPlan.find({
    dayPlanId: { $in: [...dayPlanPlanId.keys()] },
    servingTime: slot,
  })
    .select('dayPlanId')
    .lean();
  const planIdBySlot = new Map(slots.map((s) => [String(s._id), dayPlanPlanId.get(String(s.dayPlanId))]));
  if (planIdBySlot.size === 0) return new Set();

  // A slot with no items is an empty slot, not a meal to remind about.
  const filledSlotIds = await PlanItem.find({ mealSlotId: { $in: [...planIdBySlot.keys()] } }).distinct(
    'mealSlotId'
  );
  return new Set(filledSlotIds.map((id) => planIdBySlot.get(String(id))).filter(Boolean));
}

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
  const rule = await loadRule('meal_reminder');
  if (!rule.enabled) return { checked: 0, notified: 0, disabled: true };

  const today = normalizeDate(now);
  const dayKey = dayKeyFor(today);
  const todayDayGroup = resolveDayGroupForDate(today);
  const todayStart = new Date(dayKey);
  const todayEnd = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000);

  const activePlans = await DietPlan.find({ status: 'Active' })
    .select('patientId dataModel finalizedPlan.weeks weekSchedule activationDate request')
    .populate('request', 'startDateForDiet')
    .lean();

  const planItemPlanIds = await planItemPlanIdsWithSlot(
    activePlans.filter((plan) => plan.dataModel === 'plan-item'),
    slot,
    todayDayGroup,
    today
  );

  const title = render(rule.title, { slot });
  const message = render(rule.message, { slot });

  // 1. Pure-JS pass: which active-plan patients actually have `slot` on their
  //    plan today? De-duped on patientId - a patient could (rarely) hold more
  //    than one Active plan, and must not be notified twice.
  const seenPatient = new Set();
  const scheduledPatientIds = [];
  for (const plan of activePlans) {
    const pidStr = plan.patientId.toString();
    if (seenPatient.has(pidStr)) continue;
    if (plan.dataModel === 'plan-item') {
      if (planItemPlanIds.has(String(plan._id))) {
        seenPatient.add(pidStr);
        scheduledPatientIds.push(plan.patientId);
      }
      continue;
    }
    const weeks = getFinalizedWeeks(plan);
    const currentWeek = resolveCurrentWeek(plan, today);
    const week = weeks.find((w) => Number(w.week) === Number(currentWeek));
    if (!week) continue;
    const hasSlotToday = (week.dailyMeals || []).some(
      (meal) => meal.servingTime === slot && mealMatchesDayGroup(meal, todayDayGroup)
    );
    if (hasSlotToday) {
      seenPatient.add(pidStr);
      scheduledPatientIds.push(plan.patientId);
    }
  }
  if (scheduledPatientIds.length === 0) {
    return { checked: activePlans.length, notified: 0 };
  }

  // Cross-app performance optimization, Phase 2/3: the three per-patient
  // reads below (today's meal log, the idempotency check, device tokens)
  // were previously issued one patient at a time inside the loop - ~3N
  // round trips per sweep, 7 sweeps a day over every active plan. Each is
  // now a single batched `$in` query.

  // 2. Who already logged this slot today?
  const logs = await MealLog.find({ patientId: { $in: scheduledPatientIds }, dayKey })
    .select('patientId meals')
    .lean();
  const alreadyLoggedSlot = new Set(
    logs
      .filter((l) => (l.meals || []).some((m) => m.servingTime === slot))
      .map((l) => l.patientId.toString())
  );

  // 3. Idempotency guard - a manual re-trigger of the same cron route within
  //    the same day/slot must not double-notify (dedupe on title + day).
  const notLoggedIds = scheduledPatientIds.filter((id) => !alreadyLoggedSlot.has(id.toString()));
  const alreadyNotified = new Set(
    (
      await Notification.find({
        userId: { $in: notLoggedIds },
        type: 'meal_reminder',
        title,
        createdAt: { $gte: todayStart, $lt: todayEnd },
      })
        .select('userId')
        .lean()
    ).map((n) => n.userId.toString())
  );

  const toNotify = notLoggedIds.filter((id) => !alreadyNotified.has(id.toString()));
  if (toNotify.length === 0) {
    return { checked: activePlans.length, notified: 0 };
  }

  // 4. Write the in-app notifications in one go.
  await Notification.insertMany(
    toNotify.map((pid) => ({ userId: pid, title, message, type: 'meal_reminder' })),
    { ordered: false }
  );

  // 5. Device tokens for everyone we notified, then hand each recipient's
  //    push to the async job queue (Phase 3, task 3.4) so the sweep returns
  //    without waiting on N sequential FCM calls. Without REDIS_URL `enqueue`
  //    runs the send inline right here - identical to the previous loop.
  const patients = await User.find({ _id: { $in: toNotify } })
    .select('_id deviceTokens')
    .lean();
  const tokensByPatient = new Map(
    patients.map((p) => [p._id.toString(), (p.deviceTokens || []).map((t) => t.token)])
  );

  let queued = 0;
  for (const pid of toNotify) {
    const tokens = tokensByPatient.get(pid.toString()) || [];
    if (tokens.length === 0) continue;
    await enqueue('push', {
      patientId: pid.toString(),
      tokens,
      notification: {
        title,
        body: message,
        data: { deepLink: 'docwellness://timeline', servingTime: slot },
      },
    });
    queued += 1;
  }

  return { checked: activePlans.length, notified: toNotify.length, pushQueued: queued };
}

module.exports = { runMealReminderSweep };
