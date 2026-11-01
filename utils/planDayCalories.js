// What one day of a diet plan adds up to, in calories - the number Home calls
// totalPlannedCalories (utils/dailyMealLogSummary.js), computed for any past
// day so the Progress calorie chart judges each bar against the target of its
// own day. The per-meal maths (recipe index, ratio) is lifted out of
// dailyMealLogSummary.js so the two can never drift; the day lookup is built
// once per plan as a small table and every day after that is a lookup.
//
// All days here are 'YYYY-MM-DD' UTC day keys and the weekday group is derived
// from the UTC parts, so the result does not depend on the host timezone.

const { DietPlan, Recipe } = require('../models');
const { DAY_GROUPS, resolveDayGroupForDate, mealMatchesDayGroup } = require('./dayGroups');
const { getFinalizedWeeks } = require('./dietPlanLegacyView');
const { buildPlanItemPatientView, baseRecipeIdFromKey } = require('./dietPlanReadDispatch');
const { resolveCurrentWeek } = require('./dietPlanWeek');
const { computeMealRatio } = require('./weekNutritionSummary');
const { loadPatientPauses } = require('./patientPauseGuard');
const { normDate, addDays, effectiveContentDate } = require('./subscriptionPause');
const { lastWeekEndDayOf } = require('./planEnd');
const { localDateStr, resolvePlanStartUtcDay } = require('./trackingBuckets');

// A plan with no dated week covers the 4 weeks resolveCurrentWeek caps at.
const UNDATED_PLAN_DAYS = 28;

/**
 * The id -> recipe map the planned-meal maths reads: each fetched Recipe doc
 * under its own id, plus, for a plan-item plan, one entry per versioned key
 * built from the prescribed RecipeVersion (its nutritionPerServing is the
 * exact prescribed amount, serving quantity pinned to 1). A no-op overlay for
 * a days-array plan (`recipeVersionOverrides` stays empty).
 */
function buildPlannedRecipeIndex(recipeDocs, recipeVersionOverrides = {}) {
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

  return recipes;
}

/**
 * What the dietician assigned vs the recipe's own base serving(s). A
 * plan-item meal's version nutrition is already the exact prescribed amount
 * (servings is always 1), so its ratio is 1; an older plan scales by
 * computeMealRatio.
 */
function plannedMealRatio(meal, recipe, isPlanItem) {
  return isPlanItem ? 1 : computeMealRatio(meal, recipe);
}

/** One planned meal's calories; 0 when its recipe is not in the index. */
function plannedMealCalories(meal, recipes, isPlanItem) {
  const recipe = recipes[meal?.recipeId];
  if (!recipe) return 0;
  return (recipe.calories || 0) * plannedMealRatio(meal, recipe, isPlanItem);
}

/**
 * Sum of a day's meals exactly as Home adds them: meals sharing a serving time
 * and recipe share one ratio (the last one wins), and a meal whose recipe is
 * missing adds nothing.
 */
function sumDayPlannedCalories(meals, recipes, isPlanItem) {
  const ratioByKey = {};
  meals.forEach((meal) => {
    const recipe = recipes[meal.recipeId];
    if (!recipe) return;
    ratioByKey[`${meal.servingTime}:${recipe.id}`] = plannedMealRatio(meal, recipe, isPlanItem);
  });
  return meals.reduce((sum, meal) => {
    const recipe = recipes[meal.recipeId];
    if (!recipe) return sum;
    return sum + recipe.calories * (ratioByKey[`${meal.servingTime}:${recipe.id}`] ?? 1);
  }, 0);
}

/**
 * `{ [week]: { Monday, Tuesday, Wednesday, Thursday } }` planned kcal for one
 * plan: its weeks come from the plan-item view or the older finalized blob and
 * the Recipe docs are fetched once for the whole plan.
 */
async function buildPlanCalorieTable(plan) {
  const isPlanItem = plan.dataModel === 'plan-item';
  let weeks;
  let recipeVersionOverrides = {};
  if (isPlanItem) {
    const view = await buildPlanItemPatientView(plan);
    weeks = view.weeks;
    recipeVersionOverrides = view.recipeVersionOverrides;
  } else {
    weeks = getFinalizedWeeks(plan);
  }

  const recipeIds = new Set();
  weeks.forEach((week) =>
    (week.dailyMeals || []).forEach((meal) => {
      if (meal?.recipeId) recipeIds.add(baseRecipeIdFromKey(meal.recipeId.toString()));
    })
  );
  const recipeDocs = recipeIds.size
    ? await Recipe.find({ _id: { $in: Array.from(recipeIds) } })
        .select('name servingTime servingSize secondaryComponent components nutrition')
        .lean()
    : [];
  const recipes = buildPlannedRecipeIndex(recipeDocs, recipeVersionOverrides);

  const table = {};
  weeks.forEach((week) => {
    table[week.week] = {};
    DAY_GROUPS.forEach((group) => {
      const meals = (week.dailyMeals || []).filter((meal) => mealMatchesDayGroup(meal, group));
      table[week.week][group] = sumDayPlannedCalories(meals, recipes, isPlanItem);
    });
  });
  return table;
}

/**
 * The days a plan serves content, as day keys: from its start to the
 * pause-shifted end of its last week (a plan with no dated week: 28 days).
 * Null when the plan has no start at all.
 */
function planCoverage(plan, pauses = []) {
  const startDay =
    resolvePlanStartUtcDay(plan) || normDate(plan.request?.startDateForDiet);
  if (!startDay) return null;
  const startKey = localDateStr(startDay);
  const endKey =
    lastWeekEndDayOf(plan.weekSchedule, pauses) ||
    localDateStr(addDays(startDay, UNDATED_PLAN_DAYS - 1));
  return {
    key: String(plan._id ?? plan.cycleNumber),
    cycleNumber: plan.cycleNumber || 1,
    startDay: startKey,
    endDay: endKey,
    plan,
  };
}

/**
 * Target kcal for one day key, 0 when there is none: the day is paused, no
 * plan covers it (before the first plan, in a gap, after the last week), the
 * plan's table lacks that week or group, or the day's meals add up to nothing.
 * Where cycles overlap the lowest cycle wins, as on Home.
 */
function calorieTargetForDay(dayKey, coverages, tables, pauses = []) {
  const day = normDate(dayKey);
  const contentDate = day && effectiveContentDate(pauses, day);
  if (!contentDate) return 0;

  const covering = coverages
    .filter((c) => dayKey >= c.startDay && dayKey <= c.endDay)
    .sort((a, b) => a.cycleNumber - b.cycleNumber)[0];
  if (!covering) return 0;

  const week = resolveCurrentWeek(covering.plan, contentDate);
  // Built from the UTC parts so the weekday is the same on any host timezone.
  const group = resolveDayGroupForDate(
    new Date(contentDate.getUTCFullYear(), contentDate.getUTCMonth(), contentDate.getUTCDate())
  );
  const value = tables.get(covering.key)?.[week]?.[group];
  return Number.isFinite(value) ? Math.round(value) : 0;
}

/**
 * `Map<dayKey, kcal>` for every bucket of a daily range. The patient's plans
 * and pauses load once, and a table is built only for plans whose coverage
 * touches the range; a plan whose table fails to build is logged and its days
 * get 0 instead of failing the whole screen.
 */
async function loadDailyCalorieTargets(patientId, dailyBuckets) {
  const targets = new Map();
  if (!dailyBuckets.length) return targets;
  const firstDay = dailyBuckets[0].startDate;
  const lastDay = dailyBuckets[dailyBuckets.length - 1].startDate;

  const [plans, pauses] = await Promise.all([
    DietPlan.find({ patientId, status: { $ne: 'Draft' } })
      .select('cycleNumber status dataModel weekSchedule activationDate request finalizedPlan.weeks')
      .populate('request', 'startDateForDiet')
      .lean(),
    loadPatientPauses(patientId),
  ]);

  const coverages = plans
    .map((plan) => planCoverage(plan, pauses))
    .filter((c) => c && c.startDay <= lastDay && c.endDay >= firstDay);

  const tables = new Map();
  for (const coverage of coverages) {
    try {
      tables.set(coverage.key, await module.exports.buildPlanCalorieTable(coverage.plan));
    } catch (error) {
      console.error('Calorie target table failed for a plan', coverage.key, error.message);
    }
  }

  for (const bucket of dailyBuckets) {
    targets.set(bucket.startDate, calorieTargetForDay(bucket.startDate, coverages, tables, pauses));
  }
  return targets;
}

module.exports = {
  buildPlannedRecipeIndex,
  plannedMealRatio,
  plannedMealCalories,
  sumDayPlannedCalories,
  buildPlanCalorieTable,
  planCoverage,
  calorieTargetForDay,
  loadDailyCalorieTargets,
};
