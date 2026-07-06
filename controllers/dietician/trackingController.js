const { MealLog, DietPlan, User, Recipe } = require('../../models');
const WaterLog = require('../../models/WaterLog');

// Helper: get local date string YYYY-MM-DD without timezone shift
function localDateStr(date) {
  const d = new Date(date);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * GET /patients/:patientId/tracking-data?period=week|month|year
 *
 * Returns:
 * - calorieData: aggregated calorie intake from meal logs
 * - weightTrend: auto-calculated weight trend from calorie data
 * - bmiTrend: auto-calculated BMI trend from weight data
 */
exports.getPatientTrackingData = async (req, res, next) => {
  try {
    const { patientId } = req.params;
    const period = req.query.period || 'week'; // week | month | year

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
      .select('totalCalories weeksSummary activationDate calorieStrategy')
      .lean();

    const plannedDailyCalories =
      activePlan?.totalCalories || activePlan?.weeksSummary?.[0]?.totalCalories || 2000;

    // 3. Calculate date range based on period
    const now = new Date();
    let startDate, endDate;

    if (period === 'week') {
      // Current week (Monday to Sunday)
      const dayOfWeek = now.getDay();
      const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
      startDate = new Date(now);
      startDate.setDate(now.getDate() + mondayOffset);
      startDate.setHours(0, 0, 0, 0);
      endDate = new Date(startDate);
      endDate.setDate(startDate.getDate() + 6);
      endDate.setHours(23, 59, 59, 999);
    } else if (period === 'month') {
      // Current month
      startDate = new Date(now.getFullYear(), now.getMonth(), 1);
      startDate.setHours(0, 0, 0, 0);
      endDate = new Date(now.getFullYear(), now.getMonth() + 1, 0);
      endDate.setHours(23, 59, 59, 999);
    } else {
      // Current year
      startDate = new Date(now.getFullYear(), 0, 1);
      startDate.setHours(0, 0, 0, 0);
      endDate = new Date(now.getFullYear(), 11, 31);
      endDate.setHours(23, 59, 59, 999);
    }

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

    // 6. Build response based on period
    let calorieData = [];
    let weightTrend = [];
    let bmiTrend = [];

    if (period === 'week') {
      // Daily data for 7 days
      const dayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

      for (let i = 0; i < 7; i++) {
        const day = new Date(startDate);
        day.setDate(startDate.getDate() + i);
        const dayStr = localDateStr(day);

        const dayLog = mealLogs.find((log) => {
          const logDate = localDateStr(log.date);
          return logDate === dayStr;
        });

        const totalCalories = dayLog ? dayLog.totalCalories || sumMealCalories(dayLog.meals) : 0;
        const mealsLogged = dayLog ? dayLog.meals?.length || 0 : 0;

        calorieData.push({
          label: dayNames[i],
          date: dayStr,
          calories: Math.round(totalCalories),
          plannedCalories: plannedDailyCalories,
          mealsLogged,
        });
      }
    } else if (period === 'month') {
      // Weekly aggregated data for the month
      const weeksInMonth = getWeeksInMonth(startDate);

      for (let w = 0; w < weeksInMonth.length; w++) {
        const weekStart = weeksInMonth[w].start;
        const weekEnd = weeksInMonth[w].end;

        const weekLogs = mealLogs.filter((log) => {
          const logDate = new Date(log.date);
          return logDate >= weekStart && logDate <= weekEnd;
        });

        const totalCalories = weekLogs.reduce((sum, log) => {
          return sum + (log.totalCalories || sumMealCalories(log.meals));
        }, 0);

        const daysWithLogs = weekLogs.length;
        const avgCalories = daysWithLogs > 0 ? totalCalories / daysWithLogs : 0;

        calorieData.push({
          label: `Week ${w + 1}`,
          dateRange: `${formatShortDate(weekStart)} - ${formatShortDate(weekEnd)}`,
          calories: Math.round(avgCalories),
          totalCalories: Math.round(totalCalories),
          plannedCalories: plannedDailyCalories,
          daysLogged: daysWithLogs,
        });
      }
    } else {
      // Monthly aggregated data for the year
      const monthNames = [
        'Jan',
        'Feb',
        'Mar',
        'Apr',
        'May',
        'Jun',
        'Jul',
        'Aug',
        'Sep',
        'Oct',
        'Nov',
        'Dec',
      ];

      for (let m = 0; m < 12; m++) {
        const monthStart = new Date(now.getFullYear(), m, 1);
        const monthEnd = new Date(now.getFullYear(), m + 1, 0, 23, 59, 59, 999);

        const monthLogs = mealLogs.filter((log) => {
          const logDate = new Date(log.date);
          return logDate >= monthStart && logDate <= monthEnd;
        });

        const totalCalories = monthLogs.reduce((sum, log) => {
          return sum + (log.totalCalories || sumMealCalories(log.meals));
        }, 0);

        const daysWithLogs = monthLogs.length;
        const avgCalories = daysWithLogs > 0 ? totalCalories / daysWithLogs : 0;

        calorieData.push({
          label: monthNames[m],
          calories: Math.round(avgCalories),
          totalCalories: Math.round(totalCalories),
          plannedCalories: plannedDailyCalories,
          daysLogged: daysWithLogs,
        });
      }
    }

    // 7. Calculate weight trend (auto-calculated from calorie surplus/deficit)
    // Weight changes: ~7700 calories = 1 kg
    const CALORIES_PER_KG = 7700;
    let runningWeight = currentWeight;

    // Get all meal logs from activation date to build cumulative weight
    const activationDate = activePlan?.activationDate || startDate;
    const allLogs = await MealLog.find({
      patientId,
      date: { $gte: activationDate, $lte: endDate },
    })
      .sort({ date: 1 })
      .select('date totalCalories meals')
      .lean();

    // Build daily weight map from activation
    const dailyWeights = {};
    let cumulativeWeight = currentWeight;

    // Calculate weight change day by day from activation
    let currentDate = new Date(activationDate);
    currentDate.setHours(0, 0, 0, 0);

    while (currentDate <= endDate) {
      const dateStr = localDateStr(currentDate);
      const dayLog = allLogs.find((log) => {
        return localDateStr(log.date) === dateStr;
      });

      if (dayLog) {
        const consumed = dayLog.totalCalories || sumMealCalories(dayLog.meals);
        const surplus = consumed - tdee;
        cumulativeWeight += surplus / CALORIES_PER_KG;
      }
      // If no log, weight stays same (no eating recorded)

      dailyWeights[dateStr] = Math.round(cumulativeWeight * 10) / 10;

      currentDate.setDate(currentDate.getDate() + 1);
    }

    // Extract weight trend points for the requested period
    // Only include data up to today — future periods get weight=0
    const todayStr = localDateStr(now);

    if (period === 'week') {
      for (let i = 0; i < 7; i++) {
        const day = new Date(startDate);
        day.setDate(startDate.getDate() + i);
        const dayStr = localDateStr(day);

        if (dayStr > todayStr) {
          // Future day — no data
          weightTrend.push({ label: calorieData[i]?.label || '', date: dayStr, weight: 0 });
        } else {
          const weight = dailyWeights[dayStr] || currentWeight;
          weightTrend.push({
            label: calorieData[i]?.label || '',
            date: dayStr,
            weight: Math.round(weight * 10) / 10,
          });
        }
      }
    } else if (period === 'month') {
      const weeksInMonth = getWeeksInMonth(startDate);
      for (let w = 0; w < weeksInMonth.length; w++) {
        if (weeksInMonth[w].start > now) {
          // Future week — no data
          weightTrend.push({ label: `Week ${w + 1}`, date: '', weight: 0 });
        } else {
          // Use today's date if current week hasn't ended
          const effectiveEnd = weeksInMonth[w].end > now ? now : weeksInMonth[w].end;
          const weekEndStr = localDateStr(effectiveEnd);
          const weight = dailyWeights[weekEndStr] || currentWeight;
          weightTrend.push({
            label: `Week ${w + 1}`,
            date: weekEndStr,
            weight: Math.round(weight * 10) / 10,
          });
        }
      }
    } else {
      const monthNames = [
        'Jan',
        'Feb',
        'Mar',
        'Apr',
        'May',
        'Jun',
        'Jul',
        'Aug',
        'Sep',
        'Oct',
        'Nov',
        'Dec',
      ];
      for (let m = 0; m < 12; m++) {
        if (m > now.getMonth()) {
          // Future month — no data
          weightTrend.push({ label: monthNames[m], date: '', weight: 0 });
        } else {
          const effectiveEnd = m === now.getMonth() ? now : new Date(now.getFullYear(), m + 1, 0);
          const endStr = localDateStr(effectiveEnd);
          const weight = dailyWeights[endStr] || currentWeight;
          weightTrend.push({
            label: monthNames[m],
            date: endStr,
            weight: Math.round(weight * 10) / 10,
          });
        }
      }
    }

    // 8. Calculate BMI trend from weight trend (0 weight = no data = 0 bmi)
    const heightInMeters = height / 100;
    bmiTrend = weightTrend.map((point) => ({
      label: point.label,
      date: point.date,
      bmi:
        point.weight > 0
          ? Math.round((point.weight / (heightInMeters * heightInMeters)) * 10) / 10
          : 0,
      weight: point.weight,
    }));

    // 9. Date labels for x-axis
    let startLabel, endLabel;
    if (period === 'week') {
      startLabel = formatShortDate(startDate);
      endLabel = formatShortDate(endDate);
    } else if (period === 'month') {
      startLabel = formatShortDate(startDate);
      endLabel = formatShortDate(endDate);
    } else {
      startLabel = 'Jan';
      endLabel = 'Dec';
    }

    // 10. Calculate currentIndex (which bar represents "today")
    let currentIndex = 0;
    if (period === 'week') {
      // Day of week: Mon=0 .. Sun=6
      const dow = now.getDay(); // 0=Sun, 1=Mon .. 6=Sat
      currentIndex = dow === 0 ? 6 : dow - 1;
    } else if (period === 'month') {
      // Which week of the month does today fall in?
      const weeksInMonth = getWeeksInMonth(startDate);
      for (let w = 0; w < weeksInMonth.length; w++) {
        if (now >= weeksInMonth[w].start && now <= weeksInMonth[w].end) {
          currentIndex = w;
          break;
        }
      }
    } else {
      // Current month index (0-11)
      currentIndex = now.getMonth();
    }

    res.status(200).json({
      success: true,
      data: {
        period,
        dateRange: { start: startLabel, end: endLabel },
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

// Helper: sum meal calories from meals array
function sumMealCalories(meals) {
  if (!Array.isArray(meals)) return 0;
  return meals.reduce((sum, meal) => sum + (meal.caloriesConsumed || 0), 0);
}

// Helper: get weeks in a month as [{start, end}, ...]
function getWeeksInMonth(monthStart) {
  const weeks = [];
  const monthEnd = new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 0);

  let weekStart = new Date(monthStart);
  while (weekStart <= monthEnd) {
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekStart.getDate() + 6);
    if (weekEnd > monthEnd) {
      weekEnd.setTime(monthEnd.getTime());
    }
    weekEnd.setHours(23, 59, 59, 999);

    weeks.push({
      start: new Date(weekStart),
      end: new Date(weekEnd),
    });

    weekStart = new Date(weekEnd);
    weekStart.setDate(weekStart.getDate() + 1);
    weekStart.setHours(0, 0, 0, 0);
  }

  return weeks;
}

// Helper: format date as "6 Jul" style
function formatShortDate(date) {
  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];
  return `${date.getDate()} ${months[date.getMonth()]}`;
}

// ============================================================
// Dietician: get patient meal-log stats for a specific date
// GET /api/dietician/patients/:patientId/meal-log/today-stats?date=YYYY-MM-DD
// ============================================================

const parseDateOrNull = (value) => {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const normalizeDate = (dateObj) =>
  new Date(dateObj.getFullYear(), dateObj.getMonth(), dateObj.getDate());

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

    const activationStart = parseDateOrNull(dietPlan.activationDate);
    const requestStart = parseDateOrNull(dietPlan.request?.startDateForDiet);
    const startDate = activationStart || requestStart;

    let currentWeek = 1;
    if (startDate) {
      const startDay = normalizeDate(startDate);
      const diffMs = today.getTime() - startDay.getTime();
      const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
      let computedWeek = Math.floor(diffDays / 7) + 1;
      if (computedWeek < 1) computedWeek = 1;
      if (computedWeek > 4) computedWeek = 4;
      currentWeek = computedWeek;
    }

    const week = weeks.find((w) => Number(w.week) === Number(currentWeek)) || null;
    const weekSummary =
      dietPlan.weeksSummary?.find((s) => Number(s.week) === Number(currentWeek)) || null;

    const recipeIds = new Set();
    if (week) {
      (week.dailyMeals || []).forEach((meal) => {
        if (meal?.recipeId) recipeIds.add(meal.recipeId.toString());
      });
    }

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
        calories: recipe.nutrition?.calories || 0,
        protein: recipe.nutrition?.protein || 0,
        carbs: recipe.nutrition?.carbs || 0,
        fats: recipe.nutrition?.fats || 0,
        fiber: recipe.nutrition?.fiber || 0,
      };
    });

    const existingLog = await MealLog.findOne({
      patientId,
      date: today,
    }).lean();

    const loggedMeals = existingLog?.meals || [];

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
      (week.dailyMeals || []).forEach((meal) => {
        const recipe = recipes[meal.recipeId];
        if (!recipe) return;

        const logged = loggedMeals.find(
          (m) => m.servingTime === meal.servingTime && m.recipeId?.toString() === recipe.id
        );

        plannedMeals.push({
          recipeId: recipe.id,
          name: recipe.name,
          image: recipe.image,
          servingTime: meal.servingTime,
          plannedCalories: recipe.calories,
          protein: recipe.protein,
          carbs: recipe.carbs,
          fats: recipe.fats,
          fiber: recipe.fiber,
          loggedServings: logged?.servings || 0,
          caloriesConsumed: logged?.caloriesConsumed || 0,
          isLogged: !!logged,
          notes: logged?.notes || '',
        });
      });
    }

    plannedMeals.sort((a, b) => {
      return servingTimeOrder.indexOf(a.servingTime) - servingTimeOrder.indexOf(b.servingTime);
    });

    const totalPlannedCalories =
      weekSummary?.dailyCalories || plannedMeals.reduce((sum, m) => sum + m.plannedCalories, 0);
    const totalConsumedCalories = existingLog?.totalCalories || 0;
    const remainingCalories = totalPlannedCalories - totalConsumedCalories;

    const loggedCount = plannedMeals.filter((m) => m.isLogged).length;
    const totalMeals = plannedMeals.length;

    const macroConsumed = {
      protein: loggedMeals.reduce((sum, m) => {
        const recipe = recipes[m.recipeId?.toString()];
        return sum + (recipe?.protein || 0) * (m.servings || 1);
      }, 0),
      carbs: loggedMeals.reduce((sum, m) => {
        const recipe = recipes[m.recipeId?.toString()];
        return sum + (recipe?.carbs || 0) * (m.servings || 1);
      }, 0),
      fats: loggedMeals.reduce((sum, m) => {
        const recipe = recipes[m.recipeId?.toString()];
        return sum + (recipe?.fats || 0) * (m.servings || 1);
      }, 0),
      fiber: loggedMeals.reduce((sum, m) => {
        const recipe = recipes[m.recipeId?.toString()];
        return sum + (recipe?.fiber || 0) * (m.servings || 1);
      }, 0),
    };

    const macroPlanned = {
      protein: weekSummary?.dailyProtein || plannedMeals.reduce((sum, m) => sum + m.protein, 0),
      carbs: weekSummary?.dailyCarbs || plannedMeals.reduce((sum, m) => sum + m.carbs, 0),
      fats: weekSummary?.dailyFat || plannedMeals.reduce((sum, m) => sum + m.fats, 0),
      fiber: plannedMeals.reduce((sum, m) => sum + m.fiber, 0),
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
