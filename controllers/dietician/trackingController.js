const { MealLog, DietPlan, User, Recipe, ExercisePlan, ExerciseLog } = require('../../models');
const WaterLog = require('../../models/WaterLog');
const { resolveDayGroupForDate, mealMatchesDayGroup } = require('../../utils/dayGroups');
const {
  localDateStr,
  formatShortDate,
  sumMealCalories,
  addDays,
  buildDateBuckets,
  resolvePlanStartDate,
  resolveRequestedRange,
} = require('../../utils/trackingBuckets');
const { resolveCurrentWeek } = require('../../utils/dietPlanWeek');

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
    const currentWeight = healthProfile.weight || 70; // kg
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

    // 7. Calculate weight trend (auto-calculated from calorie surplus/
    // deficit, ~7700 calories = 1 kg) - cumulative from the plan's real
    // start (not just the visible range's start) so a bucket partway
    // through the plan still reflects the real trajectory.
    const CALORIES_PER_KG = 7700;
    const cumulativeStart = resolvedPlanStart || startDate;
    const allLogs = await MealLog.find({
      patientId,
      date: { $gte: cumulativeStart, $lte: endDate },
    })
      .sort({ date: 1 })
      .select('date totalCalories meals')
      .lean();

    const dailyWeights = {};
    let cumulativeWeight = currentWeight;
    let currentDate = new Date(cumulativeStart);
    currentDate.setHours(0, 0, 0, 0);

    while (currentDate <= endDate) {
      const dateStr = localDateStr(currentDate);
      const dayLog = allLogs.find((log) => localDateStr(log.date) === dateStr);
      if (dayLog) {
        const consumed = dayLog.totalCalories || sumMealCalories(dayLog.meals);
        const surplus = consumed - tdee;
        cumulativeWeight += surplus / CALORIES_PER_KG;
      }
      dailyWeights[dateStr] = Math.round(cumulativeWeight * 10) / 10;
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

    const dietPlan = await DietPlan.findOne({
      patientId,
      status: 'Active',
    })
      .populate('request', 'startDateForDiet')
      .lean();

    if (!dietPlan) {
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

    const weeks = Array.isArray(dietPlan.finalizedPlan?.weeks) ? dietPlan.finalizedPlan.weeks : [];

    // weekSchedule-aware (matches controllers/patient/dietController.js's
    // getActiveDietPlanForPatient) - a plain diff-from-activationDate estimate
    // here previously ignored weekSchedule entirely, so a week that had been
    // individually rescheduled (see utils/weekSchedule.js) made this endpoint
    // pick the wrong week's dailyMeals while the patient app picked the right
    // one, and the two apps' calorie rings disagreed for the same day.
    const currentWeek = resolveCurrentWeek(dietPlan, today);

    const week = weeks.find((w) => Number(w.week) === Number(currentWeek)) || null;

    // Each week now has 4 day-groups (Monday=Friday, Tuesday=Saturday,
    // Wednesday=Sunday, Thursday unique - see utils/dayGroups.js) - scope
    // "today's plan" down to just the group `today` falls into, same as
    // the patient-facing getActiveDietPlanForPatient does.
    const todayDayGroup = resolveDayGroupForDate(today);
    const todaysDailyMeals = week
      ? (week.dailyMeals || []).filter((meal) => mealMatchesDayGroup(meal, todayDayGroup))
      : [];

    const recipeIds = new Set();
    todaysDailyMeals.forEach((meal) => {
      if (meal?.recipeId) recipeIds.add(meal.recipeId.toString());
    });

    const existingLog = await MealLog.findOne({
      patientId,
      date: today,
    }).lean();

    const loggedMeals = existingLog?.meals || [];
    // Also fetch recipes for anything already logged, even if it falls
    // outside today's actual day-group plan - needed so consumed calories/
    // macros below can always be recomputed live from the recipe's current
    // data instead of trusting whatever was frozen into the log at submit
    // time.
    loggedMeals.forEach((m) => {
      if (m?.recipeId) recipeIds.add(m.recipeId.toString());
    });

    const recipeDocs = recipeIds.size
      ? await Recipe.find({ _id: { $in: Array.from(recipeIds) } })
          .select('name image servingSize nutrition servingTime')
          .lean()
      : [];

    const recipes = {};
    recipeDocs.forEach((recipe) => {
      const id = recipe._id.toString();
      recipes[id] = {
        id,
        name: recipe.name || null,
        image: recipe.image || null,
        servingTime: recipe.servingTime || null,
        // Base (per-recipe) nutrition/quantity - a recipe's own reference
        // serving (e.g. Steamed Rice = 300g/521kcal), not what the dietician
        // actually assigned for this specific meal slot (dailyMeals[].servings,
        // e.g. 75g). Only used below to compute the assigned-quantity ratio -
        // using these raw here previously made every planned/consumed number
        // reflect the recipe's full base size regardless of the real
        // prescribed portion (e.g. a 75g assignment showing as 300g/521kcal,
        // ~4x too much).
        baseQuantity: recipe.servingSize?.quantity || 1,
        calories: recipe.nutrition?.calories || 0,
        protein: recipe.nutrition?.protein || 0,
        carbs: recipe.nutrition?.carbs || 0,
        fats: recipe.nutrition?.fats || 0,
        fiber: recipe.nutrition?.fiber || 0,
      };
    });

    // Ratio of what the dietician actually assigned vs. the recipe's own base
    // serving, keyed by servingTime+recipeId - the single scale factor that
    // must apply to every calorie/macro number below (planned and consumed
    // alike) instead of the recipe's raw, unscaled base nutrition.
    const assignedRatioByKey = {};
    todaysDailyMeals.forEach((meal) => {
      const recipe = recipes[meal.recipeId];
      if (!recipe) return;
      const key = `${meal.servingTime}:${recipe.id}`;
      const assignedQuantity = meal.servings ?? recipe.baseQuantity;
      assignedRatioByKey[key] = recipe.baseQuantity ? assignedQuantity / recipe.baseQuantity : 1;
    });

    // Recomputed live from the recipe's *current* data (fetched by id) each
    // time, rather than trusting MealLog's frozen caloriesConsumed snapshot -
    // so if a recipe's nutrition is corrected later, every already-logged
    // meal using it reflects the correction instead of perpetuating the old
    // wrong number forever. Falls back to the stored snapshot only when the
    // recipe/ratio can't be resolved (e.g. a custom food entry).
    const liveCaloriesConsumed = (loggedMeal) => {
      const recipe = recipes[loggedMeal.recipeId?.toString()];
      const ratio =
        assignedRatioByKey[`${loggedMeal.servingTime}:${loggedMeal.recipeId?.toString()}`];
      if (recipe && ratio !== undefined) {
        return (recipe.calories || 0) * ratio * (loggedMeal.servings || 1);
      }
      return loggedMeal.caloriesConsumed || 0;
    };

    const plannedMeals = [];
    const servingTimeOrder = [
      'Morning Drink',
      'Breakfast',
      'Brunch',
      'Lunch',
      'Evening Snack',
      'Dinner',
      'Night Drink',
    ];

    if (week) {
      todaysDailyMeals.forEach((meal) => {
        const recipe = recipes[meal.recipeId];
        if (!recipe) return;

        const logged = loggedMeals.find(
          (m) => m.servingTime === meal.servingTime && m.recipeId?.toString() === recipe.id
        );
        const ratio = assignedRatioByKey[`${meal.servingTime}:${recipe.id}`] ?? 1;

        plannedMeals.push({
          recipeId: recipe.id,
          name: recipe.name,
          image: recipe.image,
          servingTime: meal.servingTime,
          plannedCalories: recipe.calories * ratio,
          protein: recipe.protein * ratio,
          carbs: recipe.carbs * ratio,
          fats: recipe.fats * ratio,
          fiber: recipe.fiber * ratio,
          loggedServings: logged?.servings || 0,
          caloriesConsumed: logged ? liveCaloriesConsumed(logged) : 0,
          isLogged: !!logged,
          notes: logged?.notes || '',
        });
      });
    }

    plannedMeals.sort((a, b) => {
      return servingTimeOrder.indexOf(a.servingTime) - servingTimeOrder.indexOf(b.servingTime);
    });

    // The real sum of *today's own* assigned meals (plannedMeals is already
    // scoped to todaysDailyMeals, this day-group only) - not
    // weekSummary.totalCalories, which is a day-group-weighted 7-day
    // *average* across all 4 day-groups (see computeWeekSummary), so it
    // never actually equals any single day's real total. Kept identical to
    // the patient-facing getTodayMealLogStats so this dietician-facing view
    // never disagrees with what the patient sees.
    const totalPlannedCalories = plannedMeals.reduce((sum, m) => sum + m.plannedCalories, 0);
    // Recomputed live per logged meal (see liveCaloriesConsumed above)
    // instead of trusting MealLog.totalCalories, a snapshot frozen at
    // whatever the recipe's calorie count was at the moment each meal was
    // logged - keeps this dietician-facing view in sync with the same
    // current recipe data the patient's own view uses.
    const totalConsumedCalories = Math.round(
      loggedMeals.reduce((sum, m) => sum + liveCaloriesConsumed(m), 0)
    );
    const remainingCalories = totalPlannedCalories - totalConsumedCalories;

    const loggedCount = plannedMeals.filter((m) => m.isLogged).length;
    const totalMeals = plannedMeals.length;

    // m.servings on a *logged* meal (MealLog.meals) is the patient's portion
    // multiplier of what was actually assigned (see getMealLogScreenData /
    // sendLogMeal on the client - "Portion 1" = ate exactly the prescribed
    // amount), not a multiplier of the recipe's raw base serving - so each
    // macro must go through the same assignedRatioByKey scale factor used
    // for plannedMeals above before applying that portion count.
    // Scaling by assignedRatioByKey (a fraction, e.g. 75g/300g = 0.25) turns
    // these into non-integer values - round at the API boundary so every
    // macro field stays a whole-gram number, same as the calorie fields
    // above.
    const macroConsumed = {
      protein: Math.round(loggedMeals.reduce((sum, m) => {
        const recipe = recipes[m.recipeId?.toString()];
        const ratio = assignedRatioByKey[`${m.servingTime}:${m.recipeId?.toString()}`] ?? 1;
        return sum + (recipe?.protein || 0) * ratio * (m.servings || 1);
      }, 0)),
      carbs: Math.round(loggedMeals.reduce((sum, m) => {
        const recipe = recipes[m.recipeId?.toString()];
        const ratio = assignedRatioByKey[`${m.servingTime}:${m.recipeId?.toString()}`] ?? 1;
        return sum + (recipe?.carbs || 0) * ratio * (m.servings || 1);
      }, 0)),
      fats: Math.round(loggedMeals.reduce((sum, m) => {
        const recipe = recipes[m.recipeId?.toString()];
        const ratio = assignedRatioByKey[`${m.servingTime}:${m.recipeId?.toString()}`] ?? 1;
        return sum + (recipe?.fats || 0) * ratio * (m.servings || 1);
      }, 0)),
      fiber: Math.round(loggedMeals.reduce((sum, m) => {
        const recipe = recipes[m.recipeId?.toString()];
        const ratio = assignedRatioByKey[`${m.servingTime}:${m.recipeId?.toString()}`] ?? 1;
        return sum + (recipe?.fiber || 0) * ratio * (m.servings || 1);
      }, 0)),
    };

    // Same reasoning as totalPlannedCalories above - today's own meals, not
    // weekSummary's cross-day-group weighted average.
    const macroPlanned = {
      protein: Math.round(plannedMeals.reduce((sum, m) => sum + m.protein, 0)),
      carbs: Math.round(plannedMeals.reduce((sum, m) => sum + m.carbs, 0)),
      fats: Math.round(plannedMeals.reduce((sum, m) => sum + m.fats, 0)),
      fiber: Math.round(plannedMeals.reduce((sum, m) => sum + m.fiber, 0)),
    };

    return res.status(200).json({
      success: true,
      data: {
        date: today,
        currentWeek,
        summary: {
          totalPlannedCalories,
          totalConsumedCalories,
          remainingCalories,
          loggedCount,
          totalMeals,
          completionPercentage: totalMeals > 0 ? Math.round((loggedCount / totalMeals) * 100) : 0,
        },
        macros: {
          consumed: macroConsumed,
          planned: macroPlanned,
        },
        meals: plannedMeals,
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
    const todayDayGroup = resolveDayGroupForDate(today);

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
      },
    });
  } catch (error) {
    next(error);
  }
};
