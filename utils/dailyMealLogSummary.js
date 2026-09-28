// Shared "today's planned meals + live-recomputed intake + macros +
// remaining calories" computation for a patient's diet plan - previously
// duplicated near-identically between controllers/patient/dietController.js
// (computeTodayMealLogStats) and controllers/dietician/trackingController.js
// (getPatientMealLogStats), "kept in sync" only by comment convention.
// Extracted here for the same reason utils/trackingBuckets.js was extracted
// from these same two controllers: so the patient's own view of a day and
// the dietician's view of that same patient's day can never silently
// diverge again.
//
// remainingCalories now includes exerciseCaloriesBurned (see
// utils/exerciseHelpers.js::sumCaloriesBurnedForDate) - previously excluded
// here and independently re-added client-side by the patient app only,
// which is what caused the patient and dietician apps to show different
// "remaining calories" numbers for the same patient/day (see the
// "unify-remaining-calories-with-exercise" OpenSpec change).

const { DietPlan, MealLog, Recipe } = require('../models');
const { resolveDayGroupForDate, mealMatchesDayGroup } = require('./dayGroups');
const { getFinalizedWeeks } = require('./dietPlanLegacyView');
const { buildPlanItemPatientView, baseRecipeIdFromKey } = require('./dietPlanReadDispatch');
const { resolveCurrentWeek } = require('./dietPlanWeek');
const { computeMealRatio } = require('./weekNutritionSummary');
const { loadPatientPauses } = require('./patientPauseGuard');
const { effectiveContentDate } = require('./subscriptionPause');
const { sumCaloriesBurnedForDate } = require('./exerciseHelpers');

const SERVING_TIME_ORDER = [
  'Morning Drink',
  'Breakfast',
  'Brunch',
  'Lunch',
  'Evening Snack',
  'Dinner',
  'Night Drink',
];

/**
 * Computes one patient's planned/consumed/remaining calories, consumed/
 * planned macros, and today's meal list for `today` (an already-normalized,
 * UTC-midnight Date - callers own normalizing whatever date string they
 * received, same as before this extraction). Returns `{ noPlan: true }`
 * when the patient has no Active diet plan, otherwise
 * `{ data, pauses, dietPlan }` - `pauses` and the lean `dietPlan` are
 * returned alongside `data` (not folded into it) so callers needing them
 * for their own caller-specific fields (the dietician's `pause.windows`,
 * the patient's plan-start/end nav dates) don't need a second query.
 */
async function computeDailyMealLogSummary(patientId, today) {
  const dietPlan = await DietPlan.findOne({
    patientId,
    status: 'Active',
  })
    .sort({ cycleNumber: 1 })
    .populate('request', 'startDateForDiet')
    .lean();

  if (!dietPlan) {
    return { noPlan: true };
  }

  // v4.0: a 'plan-item' plan has no finalizedPlan blob - synthesize its
  // weeks instead of trusting getFinalizedWeeks, which returns [] for one.
  const isPlanItem = dietPlan.dataModel === 'plan-item';
  let weeks;
  let recipeVersionOverrides = {};
  if (isPlanItem) {
    const planItemView = await buildPlanItemPatientView(dietPlan);
    weeks = planItemView.weeks;
    recipeVersionOverrides = planItemView.recipeVersionOverrides;
  } else {
    weeks = getFinalizedWeeks(dietPlan);
  }

  // Subscription pause: shifts which week/day-group "today" resolves to so
  // a patient whose plan was ever paused-and-resumed sees the same
  // week/day-group here as every other read path (Diet Plan screen,
  // meal-log submission, etc). `today` itself (the MealLog lookup below)
  // stays the real calendar date - only week/day-group resolution uses the
  // shifted one.
  const pauses = await loadPatientPauses(patientId);
  const effectiveToday = effectiveContentDate(pauses, today) || today;

  const currentWeek = resolveCurrentWeek(dietPlan, effectiveToday);
  const week = weeks.find((w) => Number(w.week) === Number(currentWeek)) || null;

  const todayDayGroup = resolveDayGroupForDate(effectiveToday);
  const todaysDailyMeals = week
    ? (week.dailyMeals || []).filter((meal) => mealMatchesDayGroup(meal, todayDayGroup))
    : [];

  // A plan-item meal.recipeId is a versioned key ("<id>::v2"); resolve it
  // back to the real Recipe._id to fetch (a no-op for a days-array plan).
  const recipeIds = new Set();
  todaysDailyMeals.forEach((meal) => {
    if (meal?.recipeId) recipeIds.add(baseRecipeIdFromKey(meal.recipeId.toString()));
  });

  const existingLog = await MealLog.findOne({ patientId, date: today }).lean();
  const loggedMeals = existingLog?.meals || [];
  // Also fetch recipes for anything already logged, even if it falls
  // outside today's actual day-group plan (e.g. logged against a stale
  // assignment) - needed so consumed calories/macros can always be
  // recomputed live from the recipe's current data instead of trusting
  // whatever was frozen into the log at submit time.
  loggedMeals.forEach((m) => {
    if (m?.recipeId) recipeIds.add(m.recipeId.toString());
  });

  const recipeDocs = recipeIds.size
    ? await Recipe.find({ _id: { $in: Array.from(recipeIds) } })
      .select('name image servingSize secondaryComponent components nutrition servingTime')
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
      servingSize: recipe.servingSize || null,
      secondaryComponent: recipe.secondaryComponent || null,
      components: recipe.components || null,
      calories: recipe.nutrition?.calories || 0,
      protein: recipe.nutrition?.protein || 0,
      carbs: recipe.nutrition?.carbs || 0,
      fats: recipe.nutrition?.fats || 0,
      fiber: recipe.nutrition?.fiber || 0,
    };
  });

  // v4.0: synthesize a per-version recipes entry (keyed by the versioned id
  // todaysDailyMeals uses) from the dietician-customized RecipeVersion - its
  // nutritionPerServing is the exact prescribed amount, so plannedMeals
  // reads it with no ratio scaling. No-op for a days-array plan
  // (recipeVersionOverrides stays {}).
  Object.entries(recipeVersionOverrides).forEach(([versionedId, override]) => {
    const base = recipes[override.baseRecipeId];
    if (!base) return;
    const n = override.nutritionPerServing || {};
    recipes[versionedId] = {
      ...base,
      id: versionedId,
      components: override.components || base.components,
      servingSize: { ...(base.servingSize || {}), quantity: 1 },
      calories: n.calories ?? base.calories,
      protein: n.protein ?? base.protein,
      carbs: n.carbs ?? base.carbs,
      fats: n.fats ?? base.fats,
      fiber: n.fiber ?? base.fiber,
    };
  });

  // Ratio of what the dietician actually assigned vs. the recipe's own base
  // serving(s), keyed by servingTime+recipeId - the single scale factor
  // that applies to every calorie/macro number below (planned and consumed
  // alike) instead of the recipe's raw, unscaled base nutrition.
  const assignedRatioByKey = {};
  todaysDailyMeals.forEach((meal) => {
    const recipe = recipes[meal.recipeId];
    if (!recipe) return;
    const baseId = baseRecipeIdFromKey(meal.recipeId.toString());
    // A plan-item meal's version nutrition is already the exact prescribed
    // amount (servings is always 1) - ratio 1, no scaling.
    const ratio = isPlanItem ? 1 : computeMealRatio(meal, recipe);
    assignedRatioByKey[`${meal.servingTime}:${recipe.id}`] = ratio;
    assignedRatioByKey[`${meal.servingTime}:${baseId}`] = ratio; // logged meals key on the base id
  });

  // Recomputed live from the recipe's *current* data each time, rather than
  // trusting MealLog's frozen caloriesConsumed snapshot - so a later recipe
  // nutrition correction shows up for every already-logged meal using it.
  // Falls back to the stored snapshot only when the recipe/ratio can't be
  // resolved (e.g. a custom "Create My Food" entry).
  const liveCaloriesConsumed = (loggedMeal) => {
    const recipe = recipes[loggedMeal.recipeId?.toString()];
    const ratio = assignedRatioByKey[`${loggedMeal.servingTime}:${loggedMeal.recipeId?.toString()}`];
    if (recipe && ratio !== undefined) {
      return (recipe.calories || 0) * ratio * (loggedMeal.servings || 1);
    }
    return loggedMeal.caloriesConsumed || 0;
  };

  const plannedMeals = [];
  if (week) {
    todaysDailyMeals.forEach((meal) => {
      const recipe = recipes[meal.recipeId];
      if (!recipe) return;

      // MealLog stores the real Recipe._id (submitMealLog normalizes the
      // versioned key), so match logged entries against the base id.
      const baseId = baseRecipeIdFromKey(meal.recipeId.toString());
      const logged = loggedMeals.find(
        (m) => m.servingTime === meal.servingTime && m.recipeId?.toString() === baseId
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

  plannedMeals.sort(
    (a, b) => SERVING_TIME_ORDER.indexOf(a.servingTime) - SERVING_TIME_ORDER.indexOf(b.servingTime)
  );

  // The real sum of *today's own* assigned meals (plannedMeals is already
  // scoped to todaysDailyMeals, this day-group only) - not weekSummary.
  // totalCalories, which is a day-group-weighted 7-day *average* across all
  // 4 day-groups, so it never actually equals any single day's real total.
  const totalPlannedCalories = plannedMeals.reduce((sum, m) => sum + m.plannedCalories, 0);
  // Recomputed live per logged meal instead of trusting MealLog.
  // totalCalories, a snapshot frozen at whatever the recipe's calorie count
  // was at the moment each meal was logged.
  const totalConsumedCalories = Math.round(
    loggedMeals.reduce((sum, m) => sum + liveCaloriesConsumed(m), 0)
  );

  // Exercise credit: earned by working out that day, folded into
  // remainingCalories rather than left as a separate, uncounted number -
  // see this module's header comment for why this must live HERE (one
  // place) rather than a convention each caller has to separately
  // remember to apply (that's exactly how it drifted before).
  const exerciseCaloriesBurned = await sumCaloriesBurnedForDate(patientId, today);
  const remainingCalories = totalPlannedCalories - totalConsumedCalories + exerciseCaloriesBurned;

  const loggedCount = plannedMeals.filter((m) => m.isLogged).length;
  const totalMeals = plannedMeals.length;

  // m.servings on a *logged* meal (MealLog.meals) is the patient's portion
  // multiplier of what was actually assigned, not a multiplier of the
  // recipe's raw base serving - so each macro must go through the same
  // assignedRatioByKey scale factor used for plannedMeals above before
  // applying that portion count. Round at the API boundary so every macro
  // field stays a whole-gram number, same as the calorie fields above.
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

  return {
    dietPlan,
    pauses,
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
  };
}

module.exports = { computeDailyMealLogSummary };
