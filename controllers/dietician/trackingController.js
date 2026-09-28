const { MealLog, DietPlan, User, Goal, Progress, ExercisePlan, ExerciseLog } = require('../../models');
const WaterLog = require('../../models/WaterLog');
const { resolveDayGroupForDate } = require('../../utils/dayGroups');
const {
  MS_PER_DAY,
  localDateStr,
  formatShortDate,
  sumMealCalories,
  addDays,
  buildDateBuckets,
  resolvePlanStartDate,
  resolveRequestedRange,
} = require('../../utils/trackingBuckets');
const { loadPatientPauses } = require('../../utils/patientPauseGuard');
const { effectiveContentDate } = require('../../utils/subscriptionPause');
const { computeDailyMealLogSummary } = require('../../utils/dailyMealLogSummary');

/**
 * GET /patients/:patientId/tracking-data?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
 *
 * Returns:
 * - calorieData: aggregated calorie intake from meal logs
 * - weightTrend: auto-calculated weight trend from calorie data
 * - bmiTrend: auto-calculated BMI trend from weight data
 *
 * Mirrors controllers/patient/progressController.js's getTrackingData (same
 * bucketing/range-clamping via utils/trackingBuckets) - this is the
 * dietician's view of a specific patient's own history, so it must agree
 * with what the patient app itself shows instead of drifting on its own
 * week/month/year period logic.
 */
exports.getPatientTrackingData = async (req, res, next) => {
  try {
    const { patientId } = req.params;

    // 1. Fetch patient health data (initial weight, height, activity level)
    const patient = await User.findById(patientId).select('healthProfile').lean();

    if (!patient) {
      return res.status(404).json({ success: false, message: 'Patient not found' });
    }

    const healthProfile = patient.healthProfile || {};
    // The patient's latest real weigh-in, not the (possibly long-stale)
    // profile field - matches controllers/patient/progressController.js's
    // own getTrackingData so the dietician's view of a patient never shows
    // a different "current weight" than the patient sees themselves.
    const latestProgressWithWeight = await Progress.findOne({
      patientId,
      weight: { $exists: true, $ne: null },
    })
      .sort({ date: -1 })
      .select('weight')
      .lean();
    const currentWeight = latestProgressWithWeight?.weight || healthProfile.weight || 70; // kg
    // Validate height: if < 100cm it's likely bad data (wrong unit or typo)
    const rawHeight = healthProfile.height || 170;
    const height = rawHeight >= 100 ? rawHeight : 170; // cm, fallback to 170 if bad data
    const activityLevel = healthProfile.activityLevel || 'Moderate';

    // 2. Get active diet plan for planned calories
    const activePlan = await DietPlan.findOne({
      patientId,
      status: 'Active',
    })
      .sort({ createdAt: -1 })
      .select('totalCalories weeksSummary activationDate weekSchedule calorieStrategy')
      .lean();

    const plannedDailyCalories =
      activePlan?.totalCalories || activePlan?.weeksSummary?.[0]?.totalCalories || 2000;

    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    // 3. The plan's real start date, and the requested [startDate, endDate]
    // range clamped to [plan start, today] - same rules the patient app's
    // own tracking-data endpoint uses.
    const resolvedPlanStart = resolvePlanStartDate(activePlan);
    const { startDate, endDate } = resolveRequestedRange(req.query, resolvedPlanStart, today);

    // 4. Fetch meal logs in the date range
    const mealLogs = await MealLog.find({
      patientId,
      date: { $gte: startDate, $lte: endDate },
    })
      .sort({ date: 1 })
      .select('date totalCalories meals')
      .lean();

    // 5. Calculate TDEE (Total Daily Energy Expenditure) for weight calculation
    const activityMultipliers = {
      Sedentary: 1.2,
      'Lightly Active': 1.375,
      'Lightly Activity': 1.375,
      Moderate: 1.55,
      'Moderately Activity': 1.55,
      'Very Active': 1.725,
      'Extra Active': 1.9,
    };
    const activityMultiplier = activityMultipliers[activityLevel] || 1.55;

    // BMR using Mifflin-St Jeor equation (assuming average)
    const bmr = 10 * currentWeight + 6.25 * height - 5 * 30 + 5; // approx for average age 30
    const tdee = bmr * activityMultiplier;

    // 6. Bucket the requested range - daily/weekly/monthly depending on how
    // wide it is - and aggregate calorie intake per bucket.
    const { buckets, granularity } = buildDateBuckets(startDate, endDate);

    const calorieData = buckets.map((bucket) => {
      const bucketLogs = mealLogs.filter((log) => {
        const logDate = new Date(log.date);
        return logDate >= bucket.start && logDate <= bucket.end;
      });
      const totalCalories = bucketLogs.reduce(
        (sum, log) => sum + (log.totalCalories || sumMealCalories(log.meals)),
        0
      );
      const daysWithLogs = bucketLogs.length;
      const avgCalories = daysWithLogs > 0 ? totalCalories / daysWithLogs : 0;
      return {
        label: bucket.label,
        dateRange: `${formatShortDate(bucket.start)} - ${formatShortDate(bucket.end)}`,
        calories: Math.round(avgCalories),
        totalCalories: Math.round(totalCalories),
        plannedCalories: plannedDailyCalories,
        daysLogged: daysWithLogs,
      };
    });

    // 7. Weight trend, anchored to the goal - mirrors
    // controllers/patient/progressController.js's getTrackingData exactly
    // (see its comment for the full reasoning): a day the patient actually
    // logged a weight on always wins outright and re-anchors the
    // projection from there; any day without a real log is projected from
    // the most recent anchor at the goal's own overall pace (startValue ->
    // targetValue across its full duration), so a weight-loss goal's
    // projection dips and a weight-gain goal's climbs, instead of the old
    // calorie-surplus simulation that anchored the whole history to
    // today's currentWeight and drifted every time meal logs changed.
    const cumulativeStart = resolvedPlanStart || startDate;
    const activeGoal = await Goal.findOne({ patientId, status: 'active' })
      .select('startValue targetValue startDate endDate')
      .lean();
    const rawTargetWeight = healthProfile.targetWeight;
    const targetWeight =
      typeof rawTargetWeight === 'number'
        ? rawTargetWeight
        : parseFloat(String(rawTargetWeight || '').replace(/[^0-9.-]/g, '')) || 0;
    const goalStartWeight = activeGoal?.startValue ?? currentWeight;
    const goalTargetWeight = activeGoal?.targetValue ?? (targetWeight || goalStartWeight);
    const planSpanDays =
      activeGoal?.startDate && activeGoal?.endDate
        ? Math.max(
            1,
            Math.round(
              (new Date(activeGoal.endDate) - new Date(activeGoal.startDate)) / MS_PER_DAY
            )
          )
        : 84; // ~12 weeks - only hit when the patient has no active goal yet.
    // Positive for a gain goal, negative for a loss goal, ~0 for maintain.
    const dailyRate = (goalTargetWeight - goalStartWeight) / planSpanDays;

    const realLogs = await Progress.find({
      patientId,
      weight: { $exists: true, $ne: null },
      date: { $gte: cumulativeStart, $lte: endDate },
    })
      .sort({ date: 1 })
      .select('date weight')
      .lean();
    // One entry per calendar day - a same-day resubmission (editing that
    // week's log) keeps only the latest write for that day.
    const loggedByDay = new Map();
    for (const log of realLogs) {
      loggedByDay.set(localDateStr(log.date), log.weight);
    }

    const dailyWeights = {};
    let anchorWeight = goalStartWeight;
    let anchorDate = new Date(cumulativeStart);
    anchorDate.setHours(0, 0, 0, 0);
    let currentDate = new Date(cumulativeStart);
    currentDate.setHours(0, 0, 0, 0);

    while (currentDate <= endDate) {
      const dateStr = localDateStr(currentDate);
      if (loggedByDay.has(dateStr)) {
        // Real data always wins - snap the projection to it and re-anchor
        // going forward from here.
        anchorWeight = loggedByDay.get(dateStr);
        anchorDate = new Date(currentDate);
        dailyWeights[dateStr] = Math.round(anchorWeight * 10) / 10;
      } else {
        const daysSinceAnchor = Math.round((currentDate - anchorDate) / MS_PER_DAY);
        dailyWeights[dateStr] = Math.round((anchorWeight + dailyRate * daysSinceAnchor) * 10) / 10;
      }
      currentDate = addDays(currentDate, 1);
    }

    const weightTrend = buckets.map((bucket, index) => {
      // Compare calendar days (not exact instants) against `today`, not
      // `now` - see progressController.js's identical fix for why this
      // matters for a bucket that legitimately starts today.
      if (bucket.start > today) {
        return { label: bucket.label, date: '', weight: 0 };
      }
      const effectiveEnd = bucket.end > now ? now : bucket.end;
      const dayStr = localDateStr(effectiveEnd);
      const weight = dailyWeights[dayStr] || currentWeight;
      return {
        label: bucket.label,
        date: dayStr,
        weight:
          index === 0 && weight <= 0
            ? Math.round(currentWeight * 10) / 10
            : Math.round(weight * 10) / 10,
      };
    });

    // 8. Calculate BMI trend from weight trend (0 weight = no data = 0 bmi)
    const heightInMeters = height / 100;
    const bmiTrend = weightTrend.map((point) => ({
      label: point.label,
      date: point.date,
      bmi:
        point.weight > 0
          ? Math.round((point.weight / (heightInMeters * heightInMeters)) * 10) / 10
          : 0,
      weight: point.weight,
    }));

    // 9. Which bucket "today" falls into, so the chart can highlight it -
    // -1 (no highlight) when the picked range doesn't include today.
    let currentIndex = -1;
    for (let i = 0; i < buckets.length; i++) {
      if (now >= buckets[i].start && now <= buckets[i].end) {
        currentIndex = i;
        break;
      }
    }

    res.status(200).json({
      success: true,
      data: {
        granularity,
        planStartDate: resolvedPlanStart ? resolvedPlanStart.toISOString() : null,
        dateRange: { start: formatShortDate(startDate), end: formatShortDate(endDate) },
        startDate: localDateStr(startDate),
        endDate: localDateStr(endDate),
        currentIndex,
        currentWeight: Math.round(currentWeight * 10) / 10,
        currentBmi: Math.round((currentWeight / (heightInMeters * heightInMeters)) * 10) / 10,
        plannedDailyCalories,
        tdee: Math.round(tdee),
        calorieData,
        weightTrend,
        bmiTrend,
      },
    });
  } catch (error) {
    next(error);
  }
};

// ============================================================
// Dietician: get patient meal-log stats for a specific date
// GET /api/dietician/patients/:patientId/meal-log/today-stats?date=YYYY-MM-DD
// ============================================================

// UTC-based - see the matching normalizeDate in controllers/patient/dietController.js
// for why: local getters made this drift by the server's UTC offset whenever
// it wasn't 0, causing already-logged days to read back as 0 consumed.
const normalizeDate = (dateObj) =>
  new Date(Date.UTC(dateObj.getUTCFullYear(), dateObj.getUTCMonth(), dateObj.getUTCDate()));

exports.getPatientMealLogStats = async (req, res, next) => {
  try {
    const { patientId } = req.params;
    const queryDate = req.query.date;
    const today = queryDate ? normalizeDate(new Date(queryDate)) : normalizeDate(new Date());

    // Planned/consumed/macro/remaining-calories computation now lives in
    // utils/dailyMealLogSummary.js, shared with the patient-facing
    // controllers/patient/dietController.js::computeTodayMealLogStats - see
    // that module's header comment for why (this dietician-facing view used
    // to duplicate the whole computation, and the two silently disagreed on
    // whether remainingCalories included exercise burned that day).
    const result = await computeDailyMealLogSummary(patientId, today);

    if (result.noPlan) {
      return res.status(200).json({
        success: true,
        data: {
          date: today,
          currentWeek: 1,
          summary: {
            totalPlannedCalories: 0,
            totalConsumedCalories: 0,
            remainingCalories: 0,
            loggedCount: 0,
            totalMeals: 0,
            completionPercentage: 0,
          },
          macros: {
            consumed: { protein: 0, carbs: 0, fats: 0, fiber: 0 },
            planned: { protein: 0, carbs: 0, fats: 0, fiber: 0 },
          },
          meals: [],
        },
      });
    }

    const { data, pauses } = result;
    return res.status(200).json({
      success: true,
      data: {
        ...data,
        // Lets the dietician's "Client Logged Data" screen show a paused
        // notice instead of this day's (possibly all-zero) numbers when the
        // *viewed* date falls in any pause window - check membership by
        // date, not "right now", since the dietician can browse to any past
        // day. Same shape as controllers/patient/dietController.js's
        // getActiveDietPlanForPatient uses on the patient side.
        pause: {
          windows: pauses.map((p) => ({ startDate: p.startDate, resumeDate: p.resumeDate })),
        },
      },
    });
  } catch (error) {
    next(error);
  }
};

// ============================================================
// Dietician: get patient water intake for a specific date
// GET /api/dietician/patients/:patientId/water/today?date=YYYY-MM-DD
// ============================================================
exports.getPatientWaterIntake = async (req, res, next) => {
  try {
    const { patientId } = req.params;
    const today = req.query.date || new Date().toISOString().split('T')[0];

    const waterLog = await WaterLog.findOne({ patientId, date: today });

    return res.status(200).json({
      success: true,
      data: waterLog || { date: today, totalAmount: 0, goal: 2500, entries: [] },
    });
  } catch (error) {
    next(error);
  }
};

// ============================================================
// Dietician: get patient exercise stats for a specific date -
// mirrors controllers/patient/exerciseController.js's
// getTodayExerciseStats, scoped by :patientId param instead of the
// logged-in user, for the Client Logged Data screen. Full logged-exercise
// list/history view is a later phase (see the Exercise Plan feature plan's
// Phase 3) - this returns just the summary numbers the Progress card needs.
// GET /api/dietician/patients/:patientId/exercise-log/today-stats?date=YYYY-MM-DD
// ============================================================
exports.getPatientExerciseStats = async (req, res, next) => {
  try {
    const { patientId } = req.params;
    const queryDate = req.query.date;
    const today = queryDate ? new Date(queryDate) : new Date();
    // Subscription pause: same content-date shift getPatientMealLogStats
    // above applies - see its comment for why.
    const pauses = await loadPatientPauses(patientId);
    const effectiveToday = effectiveContentDate(pauses, today) || today;
    const todayDayGroup = resolveDayGroupForDate(effectiveToday);

    const plan = await ExercisePlan.findOne({ patientId, status: 'Active' }).lean();
    const todaysPlanned = (plan?.dailyExercises || []).filter(
      (entry) => entry.dayGroup === todayDayGroup
    );

    const startOfDay = new Date(today);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(today);
    endOfDay.setHours(23, 59, 59, 999);

    const existingLog = await ExerciseLog.findOne({
      patientId,
      date: { $gte: startOfDay, $lte: endOfDay },
    }).lean();
    const loggedExercises = existingLog?.exercises || [];

    const totalCaloriesBurned = Math.round(
      loggedExercises.reduce((sum, e) => sum + (e.caloriesBurned || 0), 0)
    );
    const completedCount = todaysPlanned.filter((entry) =>
      loggedExercises.some((e) => e.exerciseId?.toString() === entry.exerciseId?.toString())
    ).length;

    return res.status(200).json({
      success: true,
      data: {
        totalCaloriesBurned,
        completedCount,
        totalExercises: todaysPlanned.length,
        pause: {
          windows: pauses.map((p) => ({ startDate: p.startDate, resumeDate: p.resumeDate })),
        },
      },
    });
  } catch (error) {
    next(error);
  }
};
