const { DietPlan, Recipe, Ingredient, MealLog, Chat, Conversation } = require('../../models');
const CustomFoodRequest = require('../../models/CustomFoodRequest');
const config = require('../../config/environment');
const cloudinary = require('../../config/cloudinary');
const { cloudinaryUserFolder } = require('../../utils/cloudinaryFolder');
const { resolveDayGroupForDate, mealMatchesDayGroup } = require('../../utils/dayGroups');
const { normalize } = require('../../utils/ingredientLibrary');
const fs = require('fs/promises');
const mongoose = require('mongoose');

const parseDateOrNull = (value) => {
  if (!value) {
    return null;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed;
};

// UTC-based, not local-timezone-based: dates travel between client/server as
// plain "yyyy-MM-dd" strings, which JS always parses as UTC midnight. Using
// local getters here (as this used to) made the stripped-down date drift by
// the server's UTC offset whenever it wasn't exactly 0 - e.g. under CEST
// (UTC+2), normalizing "2026-07-31" produced 2026-07-30T22:00:00.000Z instead
// of the 2026-07-31T00:00:00.000Z actually stored on MealLog, so a day that
// was fully logged still read back as 0 consumed calories.
const normalizeDate = (dateObj) =>
  new Date(Date.UTC(dateObj.getUTCFullYear(), dateObj.getUTCMonth(), dateObj.getUTCDate()));

// The plan's real week-1 start date - prefers weekSchedule (the same anchor
// used to build weekStartDate/weekEndDate everywhere else, and what the
// dietician actually picked/rescheduled - see utils/weekSchedule.js) over
// activationDate/request.startDateForDiet, which can diverge from it (e.g. a
// plan finalized on one day but scheduled to actually start on another).
// Falls back to the activation/request chain only for legacy plans that
// predate weekSchedule being populated.
const resolvePlanStartDate = (dietPlan) => {
  const weekScheduleEntries = Array.isArray(dietPlan.weekSchedule) ? dietPlan.weekSchedule : [];
  const week1Entry = weekScheduleEntries.find((entry) => Number(entry.week) === 1);
  const week1Start = week1Entry ? parseDateOrNull(week1Entry.startDate) : null;
  if (week1Start) {
    return week1Start;
  }
  const activationStart = parseDateOrNull(dietPlan.activationDate);
  const requestStart = parseDateOrNull(dietPlan.request?.startDateForDiet);
  return activationStart || requestStart;
};

// Which of the plan's 4 weeks referenceDate falls into - prefers matching
// against weekSchedule's actual date ranges (same source of truth as
// resolvePlanStartDate/weekStartDate/weekEndDate) over a diff-from-start
// estimate, which can silently disagree with it once a week's date has been
// individually rescheduled. Falls back to the diff estimate only for legacy
// plans that predate weekSchedule.
const resolveCurrentWeek = (dietPlan, referenceDate) => {
  const weekScheduleEntries = Array.isArray(dietPlan.weekSchedule) ? dietPlan.weekSchedule : [];
  if (weekScheduleEntries.length > 0) {
    const refTime = normalizeDate(referenceDate).getTime();
    const matchedEntry = weekScheduleEntries.find((entry) => {
      const entryStart = normalizeDate(entry.startDate).getTime();
      const entryEnd = normalizeDate(entry.endDate).getTime();
      return refTime >= entryStart && refTime <= entryEnd;
    });
    if (matchedEntry) {
      return matchedEntry.week;
    }
    if (refTime < normalizeDate(weekScheduleEntries[0].startDate).getTime()) {
      return weekScheduleEntries[0].week;
    }
    return weekScheduleEntries[weekScheduleEntries.length - 1].week;
  }

  const startDate = resolvePlanStartDate(dietPlan);
  if (!startDate) {
    return 1;
  }
  const startDay = normalizeDate(startDate);
  const todayDay = normalizeDate(referenceDate);
  const diffDays = Math.floor((todayDay.getTime() - startDay.getTime()) / (1000 * 60 * 60 * 24));
  let computedWeek = Math.floor(diffDays / 7) + 1;
  if (computedWeek < 1) computedWeek = 1;
  if (computedWeek > 4) computedWeek = 4;
  return computedWeek;
};

/**
 * @route   GET /api/patient/diet/active/?date=YYYY-MM-DD
 * @desc    Get currently active diet plan with recipes and summaries
 */
exports.getActiveDietPlanForPatient = async (req, res, next) => {
  try {
    const { date, week: requestedWeek } = req.query || {};
    let referenceDate = new Date();

    if (date) {
      const parsedReference = new Date(date);
      if (!Number.isNaN(parsedReference.getTime())) {
        referenceDate = parsedReference;
      }
    }

    const dietPlan = await DietPlan.findOne({
      patientId: req.user._id,
      status: 'Active',
    })
      .populate('request', 'startDateForDiet')
      .lean();

    if (!dietPlan) {
      return res.status(404).json({
        success: false,
        message: 'Active diet plan not found',
      });
    }

    const weeks = Array.isArray(dietPlan.finalizedPlan?.weeks) ? dietPlan.finalizedPlan.weeks : [];

    const recipeIds = new Set();
    weeks.forEach((week) => {
      (week?.dailyMeals || []).forEach((meal) => {
        if (meal?.recipeId) {
          recipeIds.add(meal.recipeId.toString());
        }
      });
    });

    const recipeDocs = recipeIds.size
      ? await Recipe.find({ _id: { $in: Array.from(recipeIds) } })
        .select('name servingTime nutrition image ingredients servingSize components instructions language translations tags category supplementFacts')
        .lean()
      : [];

    const recipes = {};
    recipeDocs.forEach((recipe) => {
      const id = recipe._id.toString();
      recipes[id] = {
        id,
        name: recipe.name || null,
        servingTime: recipe.servingTime || null,
        image: recipe.image || null,
        // Lets the app surface a dedicated Supplements tab (a multivitamin
        // otherwise sits anonymously, with zeroed macros, inside whatever
        // real servingTime slot it was assigned to - e.g. Night Drink -
        // easy for a patient to miss entirely). 'supplement' is synthesized
        // here from `category`, not a real stored tag - Recipe.tags' schema
        // enum is only ['side', 'salad'] - same synthesis
        // utils/dietPlanOptions.js's buildServingTimeOptionsFromDocs does
        // for the dietician app, so both apps identify a supplement the
        // same way.
        tags:
          recipe.category === 'Supplements'
            ? [...(recipe.tags || []), 'supplement']
            : recipe.tags || [],
        // Real per-serving active-ingredient facts for a supplement (see
        // models/Recipe.js) - null for every ordinary recipe. Previously
        // missing from this response entirely, so the patient app had no
        // way to show what the dietician app already displays.
        supplementFacts: recipe.supplementFacts || null,
        servingSize: {
          servings: 1,
          quantity:
            typeof recipe.servingSize?.quantity === 'number' ? recipe.servingSize.quantity : null,
          unit: recipe.servingSize?.unit || null,
        },
        nutritionPerServing: {
          calories: recipe.nutrition?.calories ?? 0,
          protein: recipe.nutrition?.protein ?? 0,
          carbs: recipe.nutrition?.carbs ?? 0,
          fats: recipe.nutrition?.fats ?? 0,
          fiber: recipe.nutrition?.fiber ?? 0,
        },
        nutrition: {
          calories: recipe.nutrition?.calories ?? 0,
          protein: recipe.nutrition?.protein ?? 0,
          carbs: recipe.nutrition?.carbs ?? 0,
          fats: recipe.nutrition?.fats ?? 0,
          fiber: recipe.nutrition?.fiber ?? 0,
        },
        ingredients: Array.isArray(recipe.ingredients)
          ? recipe.ingredients.map((ingredient) => ({
            id: ingredient._id ? ingredient._id.toString() : undefined,
            name: ingredient.name || null,
            quantity: typeof ingredient.quantity === 'number' ? ingredient.quantity : null,
            unit: ingredient.unit || null,
            image: ingredient.image || null,
            isScalable: typeof ingredient.isScalable === 'boolean' ? ingredient.isScalable : true,
          }))
          : [],
        // Independently-adjustable parts of a compound dish (e.g. Idli:
        // 3 nos, Sambar: 1 bowl, Chutney: 2 tbsp - see models/Recipe.js) -
        // the dietician app already shows these; previously missing here so
        // the patient app had no choice but to flatten a multi-part meal
        // down to just its first component's quantity/unit.
        components: Array.isArray(recipe.components)
          ? recipe.components.map((component) => ({
            label: component.label || null,
            quantity: typeof component.quantity === 'number' ? component.quantity : null,
            unit: component.unit || null,
          }))
          : [],
        instructions: Array.isArray(recipe.instructions) ? recipe.instructions : [],
        language: Array.isArray(recipe.language) ? recipe.language : [recipe.language || 'English'],
        translations: recipe.translations || {},
      };
    });

    const activationStart = parseDateOrNull(dietPlan.activationDate);
    const requestStart = parseDateOrNull(dietPlan.request?.startDateForDiet);
    const startDate = activationStart || requestStart;

    let currentWeek = null;

    // Allow explicit week selection via query param
    if (requestedWeek) {
      const parsed = parseInt(requestedWeek, 10);
      if (!Number.isNaN(parsed) && parsed >= 1 && parsed <= 4) {
        currentWeek = parsed;
      }
    }

    // Prefer weekSchedule's actual date ranges (the same source of truth
    // the dietician app's tier-cadence gate uses - see
    // utils/membershipTiers.js) over the activationDate-diff estimate below,
    // so "which week is this" agrees everywhere instead of being computed
    // two independent ways. Falls back to the diff-based computation for
    // plans that predate weekSchedule being populated.
    const weekScheduleEntries = Array.isArray(dietPlan.weekSchedule) ? dietPlan.weekSchedule : [];
    if (currentWeek === null && weekScheduleEntries.length > 0) {
      const refTime = normalizeDate(referenceDate).getTime();
      const matchedEntry = weekScheduleEntries.find((entry) => {
        const entryStart = normalizeDate(entry.startDate).getTime();
        const entryEnd = normalizeDate(entry.endDate).getTime();
        return refTime >= entryStart && refTime <= entryEnd;
      });
      if (matchedEntry) {
        currentWeek = matchedEntry.week;
      } else if (refTime < normalizeDate(weekScheduleEntries[0].startDate).getTime()) {
        currentWeek = weekScheduleEntries[0].week;
      } else {
        currentWeek = weekScheduleEntries[weekScheduleEntries.length - 1].week;
      }
    }

    // Fallback: compute week from date difference
    if (currentWeek === null && startDate) {
      const startDay = normalizeDate(startDate);
      const todayDay = normalizeDate(referenceDate);
      const diffMs = todayDay.getTime() - startDay.getTime();
      const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
      let computedWeek = Math.floor(diffDays / 7) + 1;
      if (computedWeek < 1) {
        computedWeek = 1;
      }
      if (computedWeek > 4) {
        computedWeek = 4;
      }
      currentWeek = computedWeek;
    }

    // Total weeks available in the plan
    const totalWeeks = weeks.length;

    const cycleNumber = dietPlan.cycleNumber || 1;
    const displayWeek = typeof currentWeek === 'number' ? (cycleNumber - 1) * 4 + currentWeek : null;
    const currentWeekScheduleEntry =
      typeof currentWeek === 'number'
        ? weekScheduleEntries.find((entry) => Number(entry.week) === Number(currentWeek)) || null
        : null;

    const allWeeksSummary = Array.isArray(dietPlan.weeksSummary) ? dietPlan.weeksSummary : [];

    const week =
      typeof currentWeek === 'number'
        ? weeks.find((w) => Number(w.week) === Number(currentWeek)) || null
        : null;

    const weekSummary =
      typeof currentWeek === 'number'
        ? allWeeksSummary.find((s) => Number(s.week) === Number(currentWeek)) || null
        : null;

    if (week) {
      // Each week now has 4 day-groups (Monday=Friday, Tuesday=Saturday,
      // Wednesday=Sunday, Thursday unique - see utils/dayGroups.js) instead
      // of one flat meal set applying to all 7 days. This endpoint used to
      // filter dailyMeals down to just the group referenceDate falls into,
      // which meant the Diet Plan screen had to re-hit this endpoint on
      // every single day tap (not just every week tap) to pick up the other
      // 3 groups - a full-screen loading flash per tap. Instead, return
      // every group's meals together (each meal already carries its own
      // dayGroup - see mealMatchesDayGroup) and let the app pick the right
      // one for whichever day is selected, entirely client-side. A meal
      // with no dayGroup (pre-migration plans) has no group to filter by
      // anyway, so this is also just a strict superset of the old response
      // for those plans.
      const todayDayGroup = resolveDayGroupForDate(referenceDate);
      const fixMeals = (dailyMeals) =>
        (dailyMeals || []).map((meal) => ({
          ...meal,
          recipeId: meal.recipeId || '',
        }));

      const weekWithFixedMeals = {
        ...week,
        dailyMeals: fixMeals(week.dailyMeals),
      };

      // All weeks the plan actually has, carrying every day-group the same
      // way as the single `week` field above - lets the app fetch once per
      // Diet-tab visit and switch weeks *and* days client-side with no
      // per-tap network round trip. The expensive part (loading
      // finalizedPlan.weeks + resolving every recipe in the plan, above)
      // already happens on every call regardless of which week was
      // requested, so this is close to free.
      const allWeeksData = weeks.map((w) => {
        const weekNum = Number(w.week);
        const scheduleEntry =
          weekScheduleEntries.find((entry) => Number(entry.week) === weekNum) || null;
        const summary = allWeeksSummary.find((s) => Number(s.week) === weekNum) || null;
        return {
          week: weekNum,
          weekStartDate: scheduleEntry?.startDate || null,
          weekEndDate: scheduleEntry?.endDate || null,
          weekSummary: summary,
          dailyMeals: fixMeals(w.dailyMeals),
        };
      });

      return res.status(200).json({
        success: true,
        data: {
          dietPlanId: dietPlan._id,
          status: dietPlan.status,
          activationDate: dietPlan.activationDate || null,
          currentWeek,
          totalWeeks,
          // cycleNumber/displayWeek let the app show "Week 5" etc. for a
          // renewed patient's second (or later) cycle, without changing
          // currentWeek's own internal 1-4 meaning (see models/DietPlan.js).
          cycleNumber,
          displayWeek,
          weekStartDate: currentWeekScheduleEntry?.startDate || null,
          weekEndDate: currentWeekScheduleEntry?.endDate || null,
          dayGroup: todayDayGroup,
          weekSummary, // single object for the current week
          week: weekWithFixedMeals, // the current week’s dailyMeals with fixed recipeId
          weeks: allWeeksData, // every week in the plan, for client-side caching
          recipes, // keep as-is (all recipes map)
        },
      });
    }
  } catch (error) {
    next(error);
  }
};

/**
 * @route   GET /api/patient/diet/week-completion?week=N
 * @desc    Whether every planned meal in diet-plan week N has actually been
 *          logged, per day and in aggregate - lets the app collapse a
 *          fully-logged week's day-strip down to a single "Week N" chip
 *          (see diet_view.dart). "Complete" means every servingTime slot
 *          planned for that date (via the same day-group resolution
 *          getActiveDietPlanForPatient itself uses) has a matching MealLog
 *          entry - not just "calories reached", since over/under-eating one
 *          slot shouldn't mask a completely unlogged one, and a day with no
 *          planned meals at all never counts as "complete" (nothing to
 *          verify against).
 * @access  Private (Patient)
 */
exports.getWeekCompletion = async (req, res, next) => {
  try {
    const { week: requestedWeek } = req.query || {};
    const weekNum = parseInt(requestedWeek, 10);
    if (!weekNum || weekNum < 1) {
      return res.status(400).json({
        success: false,
        message: 'A valid week query param is required',
      });
    }

    const dietPlan = await DietPlan.findOne({
      patientId: req.user._id,
      status: 'Active',
    }).lean();
    if (!dietPlan) {
      return res.status(404).json({
        success: false,
        message: 'Active diet plan not found',
      });
    }

    const weekScheduleEntries = Array.isArray(dietPlan.weekSchedule) ? dietPlan.weekSchedule : [];
    const scheduleEntry = weekScheduleEntries.find((e) => Number(e.week) === weekNum);
    const weekStartRaw = scheduleEntry ? parseDateOrNull(scheduleEntry.startDate) : null;
    if (!weekStartRaw) {
      return res.status(404).json({
        success: false,
        message: `No schedule found for week ${weekNum}`,
      });
    }
    const weekStart = normalizeDate(weekStartRaw);

    const weeks = Array.isArray(dietPlan.finalizedPlan?.weeks) ? dietPlan.finalizedPlan.weeks : [];
    const weekData = weeks.find((w) => Number(w.week) === weekNum);
    const dailyMeals = weekData?.dailyMeals || [];

    const dates = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(weekStart);
      d.setUTCDate(d.getUTCDate() + i);
      return d;
    });

    const mealLogs = await MealLog.find({
      patientId: req.user._id,
      date: { $gte: dates[0], $lte: dates[6] },
    })
      .select('date meals.servingTime')
      .lean();

    const loggedByDateKey = new Map();
    for (const log of mealLogs) {
      const key = normalizeDate(new Date(log.date)).toISOString().slice(0, 10);
      const set = loggedByDateKey.get(key) || new Set();
      for (const m of log.meals || []) {
        if (m.servingTime) set.add(m.servingTime);
      }
      loggedByDateKey.set(key, set);
    }

    const days = dates.map((date) => {
      const dayGroup = resolveDayGroupForDate(date);
      const plannedSlots = new Set(
        dailyMeals
          .filter((m) => mealMatchesDayGroup(m, dayGroup) && m.servingTime)
          .map((m) => m.servingTime)
      );
      const key = date.toISOString().slice(0, 10);
      const loggedSlots = loggedByDateKey.get(key) || new Set();
      const complete = plannedSlots.size > 0 && [...plannedSlots].every((slot) => loggedSlots.has(slot));
      return {
        date: key,
        dayGroup,
        plannedSlots: plannedSlots.size,
        loggedSlots: loggedSlots.size,
        complete,
      };
    });

    const complete = days.length > 0 && days.every((d) => d.complete);

    return res.status(200).json({
      success: true,
      data: { week: weekNum, complete, days },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Rounds a friendly "~N unit" count for display - e.g. 330g of onion at
 * ~110g/piece becomes "~3". Never shows "~0" or "~1" as a false-precision
 * single unit when the total barely clears a whole unit; below half a unit
 * there's nothing meaningful to show at all.
 */
/**
 * Formats a quantity+unit for the grocery list's uniform-unit display -
 * "40g"/"7750ml" (no space, matches the existing base-unit style) for the
 * two measured units, "5 piece"/"2 cup" (space, matches how the per-recipe
 * breakdown already renders these - see addRecipeUsage) for every other
 * unit, so the total and its own breakdown always read consistently.
 */
const formatUnitQuantity = (quantity, unit) => {
  if (unit === 'g' || unit === 'ml') return `${quantity}${unit}`;
  return `${quantity} ${unit}`;
};

const friendlyPieceCount = (totalBaseQuantity, gramsPerPiece) => {
  if (!gramsPerPiece) return null;
  const count = Math.round(totalBaseQuantity / gramsPerPiece);
  return count > 0 ? count : null;
};

/**
 * Accumulates one recipe's ingredient occurrence into a grocery item's
 * per-recipe "used in" breakdown, keyed by recipeId so the same recipe
 * appearing on multiple days of the week (e.g. Jowar Bhakri served 6 times)
 * collapses into a single row with the summed quantity instead of repeating
 * that recipe N times. Quantity/unit stay in the RECIPE'S ORIGINAL unit (not
 * base-unit converted) so the breakdown still reads naturally, e.g.
 * "2 tbsp" for one recipe and "1 cup" for another.
 */
const addRecipeUsage = (item, recipe, ingredient) => {
  const usage = item._recipeUsage[recipe.id];
  const quantity = typeof ingredient.quantity === 'number' ? ingredient.quantity : null;
  if (!usage) {
    item._recipeUsage[recipe.id] = {
      recipeId: recipe.id,
      recipeName: recipe.name,
      recipeImage: recipe.image || null,
      servingTime: recipe.servingTime || null,
      quantity,
      unit: ingredient.unit || null,
    };
    return;
  }
  if (quantity !== null) {
    usage.quantity = (usage.quantity || 0) + quantity;
  }
};

/**
 * @route   GET /api/patient/diet/groceries
 * @desc    Get grocery list for the current active week
 */
exports.getGroceriesForCurrentWeek = async (req, res, next) => {
  try {
    const { date } = req.query || {};
    let referenceDate = new Date();

    if (date) {
      const parsedReference = new Date(date);
      if (!Number.isNaN(parsedReference.getTime())) {
        referenceDate = parsedReference;
      }
    }

    const dietPlan = await DietPlan.findOne({
      patientId: req.user._id,
      status: 'Active',
    })
      .populate('request', 'startDateForDiet')
      .lean();

    if (!dietPlan) {
      return res.status(404).json({
        success: false,
        message: 'Active diet plan not found',
      });
    }

    const weeks = Array.isArray(dietPlan.finalizedPlan?.weeks) ? dietPlan.finalizedPlan.weeks : [];

    // Determine current week FIRST — then only fetch recipes for that week.
    // Prefer weekSchedule's actual date ranges (the same source of truth
    // used everywhere else in this file - see getActiveDietPlan above) over
    // the activationDate-diff estimate below, so the grocery list always
    // agrees with which week the rest of the app thinks it is. Falling back
    // to the diff-based computation only for plans that predate
    // weekSchedule being populated avoids the two ever silently diverging
    // (e.g. if activationDate is ever adjusted independently of the plan's
    // real week-1 start).
    let currentWeek = null;
    const weekScheduleEntries = Array.isArray(dietPlan.weekSchedule) ? dietPlan.weekSchedule : [];
    if (weekScheduleEntries.length > 0) {
      const refTime = normalizeDate(referenceDate).getTime();
      const matchedEntry = weekScheduleEntries.find((entry) => {
        const entryStart = normalizeDate(entry.startDate).getTime();
        const entryEnd = normalizeDate(entry.endDate).getTime();
        return refTime >= entryStart && refTime <= entryEnd;
      });
      if (matchedEntry) {
        currentWeek = matchedEntry.week;
      } else if (refTime < normalizeDate(weekScheduleEntries[0].startDate).getTime()) {
        currentWeek = weekScheduleEntries[0].week;
      } else {
        currentWeek = weekScheduleEntries[weekScheduleEntries.length - 1].week;
      }
    }

    if (currentWeek === null) {
      const activationStart = parseDateOrNull(dietPlan.activationDate);
      const requestStart = parseDateOrNull(dietPlan.request?.startDateForDiet);
      const startDate = activationStart || requestStart;

      if (startDate) {
        const startDay = normalizeDate(startDate);
        const todayDay = normalizeDate(referenceDate);
        const diffMs = todayDay.getTime() - startDay.getTime();
        const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
        let computedWeek = Math.floor(diffDays / 7) + 1;
        if (computedWeek < 1) computedWeek = 1;
        if (computedWeek > 4) computedWeek = 4;
        currentWeek = computedWeek;
      }
    }

    const week =
      typeof currentWeek === 'number'
        ? weeks.find((w) => Number(w.week) === Number(currentWeek)) || null
        : null;

    if (!week) {
      return res.status(200).json({
        success: true,
        data: { week: currentWeek, items: [] },
      });
    }

    // Collect recipe IDs only from the current week — previous/future weeks excluded
    const recipeIds = new Set();
    (week.dailyMeals || []).forEach((meal) => {
      if (meal?.recipeId) recipeIds.add(meal.recipeId.toString());
    });

    const recipeDocs = recipeIds.size
      ? await Recipe.find({ _id: { $in: Array.from(recipeIds) } })
        .select('name servingTime image ingredients category')
        .lean()
      : [];

    const recipes = {};
    recipeDocs.forEach((recipe) => {
      const id = recipe._id.toString();
      recipes[id] = {
        id,
        name: recipe.name || null,
        servingTime: recipe.servingTime || null,
        image: recipe.image || null,
        isSupplement: recipe.category === 'Supplements',
        ingredients: Array.isArray(recipe.ingredients)
          ? recipe.ingredients.map((ingredient) => ({
            name: ingredient.name || null,
            quantity: typeof ingredient.quantity === 'number' ? ingredient.quantity : null,
            unit: ingredient.unit || null,
            category: ingredient.category || null,
            priceLevel: ingredient.priceLevel || null,
            image: ingredient.image || null,
          }))
          : [],
      };
    });

    // Canonical ingredient registry (see models/Ingredient.js,
    // scripts/migrate-canonical-ingredients.js) - loaded once, keyed by
    // normalizedName, so aggregation below is a fast in-memory lookup
    // instead of a per-ingredient query. Recipe ingredient names were
    // already rewritten to their canonical spelling by that migration, so
    // this is an exact lookup, not fuzzy matching.
    const registryDocs = await Ingredient.find({ dieticianId: dietPlan.dieticianId }).lean();
    const registry = {};
    registryDocs.forEach((doc) => {
      registry[doc.normalizedName] = doc;
    });

    const groceryMap = {};

    (week.dailyMeals || []).forEach((meal) => {
      const recipe = recipes[meal.recipeId];
      if (!recipe) return;

      recipe.ingredients.forEach((ingredient) => {
        // Supplements' ingredients (e.g. "Multivitamin Tablet") are a
        // self-referential, self-contained namespace - not part of the
        // canonical registry and never merged with food ingredients, just
        // included as their own unmerged line item (see
        // migrate-canonical-ingredients.js's doc comment on why Supplements
        // are excluded from that migration).
        if (recipe.isSupplement) {
          const key = `supplement:${ingredient.name}`;
          if (!groceryMap[key]) {
            groceryMap[key] = {
              name: ingredient.name,
              unit: ingredient.unit || null,
              totalQuantity: 0,
              displayQuantity: null,
              category: ingredient.category || null,
              priceLevel: ingredient.priceLevel || null,
              recipesUsedIn: [],
              purchased: false,
              image: ingredient.image || null,
              isSupplement: true,
              _recipeUsage: {}, // recipeId -> accumulated entry, see below
            };
          }
          if (typeof ingredient.quantity === 'number') {
            groceryMap[key].totalQuantity += ingredient.quantity;
            groceryMap[key].displayQuantity = `${groceryMap[key].totalQuantity} ${ingredient.unit || ''}`.trim();
          }
          addRecipeUsage(groceryMap[key], recipe, ingredient);
          return;
        }

        const normalizedName = normalize(ingredient.name || '');
        const registryEntry = registry[normalizedName];
        const key = normalizedName;

        if (!groceryMap[key]) {
          groceryMap[key] = {
            name: registryEntry?.name || ingredient.name,
            unit: null, // resolved below once we know whether this is a solids/liquids item
            totalQuantity: 0, // always in the base unit (grams, or ml for liquids)
            displayQuantity: null,
            category: registryEntry?.category || ingredient.category || null,
            priceLevel: ingredient.priceLevel || null,
            recipesUsedIn: [],
            purchased: false,
            image: registryEntry?.image || ingredient.image || null,
            isSupplement: false,
            _conversionIncomplete: false,
            _recipeUsage: {}, // recipeId -> accumulated entry, see below
            // Every distinct unit this ingredient was actually recorded in
            // across the week's recipes, plus a running total in that unit
            // (only meaningful once _unitsSeen.size === 1) - see the
            // uniform-unit display branch below. When every recipe agrees
            // on the unit (e.g. every "Date" occurrence is in "piece"),
            // the shopper wants "5 piece", not a gram-equivalent they'd
            // have to convert back in their head - the base-unit total
            // above is still computed regardless, for the genuinely-mixed-
            // unit case (e.g. one recipe's "2 tbsp" and another's "1 cup"
            // of the same ingredient, which has no single natural unit to
            // report in).
            _unitsSeen: new Set(),
            _uniformUnitQuantity: 0,
          };
        }
        const item = groceryMap[key];

        if (typeof ingredient.quantity === 'number') {
          if (ingredient.unit) {
            item._unitsSeen.add(ingredient.unit);
            item._uniformUnitQuantity += ingredient.quantity;
          } else {
            // No unit at all can never be "uniform" - force the mixed-unit
            // fallback rather than silently summing unitless numbers.
            item._unitsSeen.add(null);
          }

          const conversions = registryEntry?.unitConversions || {};
          const factor = conversions[ingredient.unit];
          // Liquids (Water, Oil, Milk) are recorded in ml; everything else
          // in grams - infer from whichever unit key the registry actually
          // has a factor for, defaulting to grams.
          const baseUnit = conversions.ml && !conversions.g ? 'ml' : 'g';
          item.unit = baseUnit;

          if (typeof factor === 'number') {
            item.totalQuantity += ingredient.quantity * factor;
          } else {
            // Conversion factor unexpectedly missing (shouldn't happen
            // post-migration) - fall back to a raw sum rather than
            // throwing, but flag it so this line's total isn't silently
            // trusted as precise.
            item.totalQuantity += ingredient.quantity;
            item._conversionIncomplete = true;
          }
        }

        addRecipeUsage(item, recipe, ingredient);
      });
    });

    const items = Object.values(groceryMap).map((item) => {
      // The same recipe can appear multiple times across the week's
      // dailyMeals (e.g. Jowar Bhakri served on 6 different days) - collapse
      // those into a single "used in" row with the summed quantity, rather
      // than repeating the same recipe name N times.
      item.recipesUsedIn = Object.values(item._recipeUsage).map((usage) => ({
        ...usage,
        quantity: usage.quantity !== null ? Math.round(usage.quantity * 10) / 10 : null,
      }));
      delete item._recipeUsage;

      const rounded = Math.round(item.totalQuantity * 10) / 10;
      let displayQuantity = item.displayQuantity;
      const unitsSeen = item._unitsSeen || new Set();
      if (!item.isSupplement) {
        if (unitsSeen.size === 1 && !unitsSeen.has(null)) {
          // Every recipe recorded this ingredient in the same unit - show
          // the total directly in that unit (e.g. "5 piece", "2 cup")
          // instead of a converted/hidden gram figure. Uses the raw
          // same-unit sum, not a round-trip through the base-unit
          // conversion factor, so this is exact, not approximated.
          const [uniformUnit] = unitsSeen;
          const uniformRounded = Math.round(item._uniformUnitQuantity * 10) / 10;
          displayQuantity = formatUnitQuantity(uniformRounded, uniformUnit);
        } else {
          const normalizedName = normalize(item.name || '');
          const registryEntry = registry[normalizedName];
          const pieceCount = registryEntry
            ? friendlyPieceCount(item.totalQuantity, registryEntry.unitConversions?.piece)
            : null;
          const friendlyLabel = registryEntry?.friendlyUnitLabel;
          displayQuantity =
            pieceCount && friendlyLabel
              ? `${rounded}${item.unit} (~${pieceCount} ${friendlyLabel})`
              : `${rounded}${item.unit}`;
          if (item._conversionIncomplete) {
            displayQuantity += ' (approx)';
          }
        }
      }
      delete item._conversionIncomplete;
      delete item._unitsSeen;
      delete item._uniformUnitQuantity;
      return { ...item, totalQuantity: rounded, displayQuantity };
    });

    return res.status(200).json({
      success: true,
      data: {
        week: currentWeek,
        items,
      },
    });
  } catch (error) {
    next(error);
  }
};

exports.getTodayMealLogStats = async (req, res, next) => {
  try {
    const queryDate = req.query.date;
    const today = queryDate ? normalizeDate(new Date(queryDate)) : normalizeDate(new Date());

    const dietPlan = await DietPlan.findOne({
      patientId: req.user._id,
      status: 'Active',
    })
      .populate('request', 'startDateForDiet')
      .lean();

    if (!dietPlan) {
      return res.status(404).json({
        success: false,
        message: 'Active diet plan not found',
      });
    }

    const weeks = Array.isArray(dietPlan.finalizedPlan?.weeks) ? dietPlan.finalizedPlan.weeks : [];

    const currentWeek = resolveCurrentWeek(dietPlan, today);

    const week = weeks.find((w) => Number(w.week) === Number(currentWeek)) || null;

    // Each week now has 4 day-groups (Monday=Friday, Tuesday=Saturday,
    // Wednesday=Sunday, Thursday unique - see utils/dayGroups.js) bundled
    // together in dailyMeals - scope "today's plan" down to just the group
    // `today` falls into, same as getActiveDietPlanForPatient/
    // getPatientMealLogStats (dietician side) already do. Missing this
    // filter here summed all 4 groups' meals together, inflating planned
    // calories ~4x+ over the real daily target.
    const todayDayGroup = resolveDayGroupForDate(today);
    const todaysDailyMeals = week
      ? (week.dailyMeals || []).filter((meal) => mealMatchesDayGroup(meal, todayDayGroup))
      : [];

    const recipeIds = new Set();
    todaysDailyMeals.forEach((meal) => {
      if (meal?.recipeId) recipeIds.add(meal.recipeId.toString());
    });

    const existingLog = await MealLog.findOne({
      patientId: req.user._id,
      date: today,
    }).lean();

    const loggedMeals = existingLog?.meals || [];
    // Also fetch recipes for anything already logged, even if it falls
    // outside today's actual day-group plan (e.g. logged against a stale
    // assignment) - needed so consumed calories/macros below can always be
    // recomputed live from the recipe's current data instead of trusting
    // whatever was frozen into the log at the moment it was submitted.
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
    // so if a recipe's nutrition is corrected later (e.g. the Jowar Bhakri/
    // Bajra Bhakri/Chapati/Steamed Rice fixes), every already-logged meal
    // using it reflects the correction instead of perpetuating the old wrong
    // number forever. Falls back to the stored snapshot only when the
    // recipe/ratio can't be resolved (e.g. a custom "Create My Food" entry
    // with no matching plan recipe to sync against).
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
    // never actually equals any single day's real total and drifted from
    // what the dietician's own "Selected Calories" shows for that specific
    // day. Patients need today's real planned total, not a cross-day
    // average.
    const totalPlannedCalories = plannedMeals.reduce((sum, m) => sum + m.plannedCalories, 0);
    // Recomputed live per logged meal (see liveCaloriesConsumed above)
    // instead of trusting MealLog.totalCalories, a snapshot frozen at
    // whatever the recipe's calorie count was at the moment each meal was
    // logged - this is what keeps the displayed "Intake" in sync with the
    // dietician's current assigned calories rather than stale history.
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
    // above. The client casts these `as int` (see HomeController.
    // fetchTodayStats), which throws on a raw double.
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

    const resolvedPlanStartDate = resolvePlanStartDate(dietPlan);
    const planStartDate = resolvedPlanStartDate ? normalizeDate(resolvedPlanStartDate) : null;
    const planEndDate = planStartDate
      ? new Date(planStartDate.getFullYear(), planStartDate.getMonth() + 1, planStartDate.getDate())
      : null;

    return res.status(200).json({
      success: true,
      data: {
        date: today,
        currentWeek,
        planStartDate: planStartDate ? planStartDate.toISOString() : null,
        planEndDate: planEndDate ? planEndDate.toISOString() : null,
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
        canEdit: true,
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @route   GET /api/patient/meal-log/screen-data
 * @desc    Get data for the Log Meal screen
 */
exports.getMealLogScreenData = async (req, res, next) => {
  try {
    const { date } = req.query || {};

    if (!date) {
      return res.status(400).json({
        success: false,
        message: 'Date is required',
      });
    }

    const targetDate = normalizeDate(new Date(date));
    const today = normalizeDate(new Date());
    const isPresentDate = targetDate.getTime() === today.getTime();

    const dietPlan = await DietPlan.findOne({
      patientId: req.user._id,
      status: 'Active',
    })
      .populate('request', 'startDateForDiet')
      .lean();

    if (!dietPlan) {
      return res.status(404).json({
        success: false,
        message: 'Active diet plan not found',
      });
    }

    const weeks = Array.isArray(dietPlan.finalizedPlan?.weeks) ? dietPlan.finalizedPlan.weeks : [];

    const recipeIds = new Set();
    weeks.forEach((week) => {
      (week?.dailyMeals || []).forEach((meal) => {
        if (meal?.recipeId) {
          recipeIds.add(meal.recipeId.toString());
        }
      });
    });

    const recipeDocs = recipeIds.size
      ? await Recipe.find({ _id: { $in: Array.from(recipeIds) } })
        .select('name image servingSize nutrition')
        .lean()
      : [];

    const recipes = {};
    recipeDocs.forEach((recipe) => {
      const id = recipe._id.toString();
      recipes[id] = {
        id,
        name: recipe.name || null,
        image: recipe.image || null,
        // Base (per-recipe) serving/calories - only used below to compute the
        // dietician's assigned-quantity ratio; never sent as-is (see the
        // plannedMeals loop, which previously sent this raw base regardless
        // of dailyMeals[].servings, so e.g. a 75g assignment displayed and
        // logged as the recipe's full 300g/521kcal base - ~4x too much).
        baseQuantity: recipe.servingSize?.quantity || 1,
        totalWeightUnit: recipe.servingSize?.unit || null,
        baseCalories: recipe.nutrition?.calories || 0,
      };
    });

    const currentWeek = resolveCurrentWeek(dietPlan, targetDate);

    const week =
      typeof currentWeek === 'number'
        ? weeks.find((w) => Number(w.week) === Number(currentWeek)) || null
        : null;

    // Load existing log for this date (if any)
    const existingLog = await MealLog.findOne({
      patientId: req.user._id,
      date: targetDate,
    }).lean();

    const loggedMeals = existingLog?.meals || [];

    // Map: "servingTime:recipeId" -> servings
    const loggedMap = {};
    loggedMeals.forEach((m) => {
      if (!m.recipeId) return;
      const key = `${m.servingTime}:${m.recipeId.toString()}`;
      loggedMap[key] = m.servings || 0;
    });

    const servingTimesMap = {};

    if (week) {
      // Same fix as getActiveDietPlanForPatient above - week.dailyMeals
      // holds all 4 day-groups mixed together, so without this filter Log
      // Meal showed every day-group's recipes for a slot at once (e.g.
      // Monday's AND Tuesday's AND Wednesday's AND Thursday's Lunch combos
      // all together) instead of just what the dietician actually assigned
      // for targetDate's specific day.
      const targetDayGroup = resolveDayGroupForDate(targetDate);
      (week.dailyMeals || []).filter((meal) => mealMatchesDayGroup(meal, targetDayGroup)).forEach((meal) => {
        const recipe = recipes[meal.recipeId];
        if (!recipe) return;

        if (!servingTimesMap[meal.servingTime]) {
          servingTimesMap[meal.servingTime] = {
            servingTime: meal.servingTime,
            plannedMeals: [],
          };
        }

        const key = `${meal.servingTime}:${recipe.id}`;
        const loggedServings = loggedMap[key] || 0; // 0 if not logged yet

        // Show what the dietician actually assigned (dailyMeals[].servings,
        // e.g. 75g) and its correctly-scaled calories, not the recipe's raw
        // base serving/calories.
        const assignedQuantity = meal.servings ?? recipe.baseQuantity;
        const ratio = recipe.baseQuantity ? assignedQuantity / recipe.baseQuantity : 1;

        servingTimesMap[meal.servingTime].plannedMeals.push({
          recipeId: recipe.id,
          name: recipe.name,
          image: recipe.image,
          totalWeight: assignedQuantity,
          totalWeightUnit: recipe.totalWeightUnit,
          calories: Math.round(recipe.baseCalories * ratio),
          // Portion is a multiplier of the assigned serving above (1 = ate
          // exactly what was prescribed). Unlogged items must start at 0 -
          // showing 1 by default (as this used to) looked identical to an
          // already-logged "ate exactly 1x" entry, with no visual way to
          // tell them apart. 0 is now a valid dropdown option on the client
          // (see CustomPortionDropDown's items list) and is excluded from
          // submission, so the patient explicitly opts in per item logged.
          portion: loggedServings,
        });
      });
    }

    return res.status(200).json({
      success: true,
      data: {
        date: targetDate,
        isPresentDate,
        servingTimes: Object.values(servingTimesMap),
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @route   POST /api/patient/meal-log
 * @desc    Submit logged meals
 */
exports.submitMealLog = async (req, res, next) => {
  try {
    const { date, items } = req.body;

    // Normalize the date
    const targetDate = normalizeDate(new Date(date));
    const today = normalizeDate(new Date());

    // Reject if the target date is in the past
    if (targetDate < today) {
      return res.status(400).json({
        success: false,
        message: 'Cannot modify past meal logs',
      });
    }

    // Validate items
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Items must be a non-empty array',
      });
    }

    for (const item of items) {
      if (
        !item.servingTime ||
        !mongoose.Types.ObjectId.isValid(item.recipeId) ||
        typeof item.servings !== 'number' ||
        item.servings <= 0
      ) {
        return res.status(400).json({
          success: false,
          message: 'Invalid item in items array',
        });
      }
    }

    // Find or create the MealLog document
    let log = await MealLog.findOne({ patientId: req.user._id, date: targetDate });
    const isFirstTime = !log;
    if (!log) {
      log = new MealLog({
        patientId: req.user._id,
        date: targetDate,
        meals: [],
        totalCalories: 0,
      });
    }

    // Overwrite-or-append per (servingTime, recipeId)
    items.forEach((item) => {
      const newCalories = item.caloriesConsumed || 0;

      const existing = log.meals.find(
        (meal) =>
          meal.servingTime === item.servingTime &&
          meal.recipeId &&
          meal.recipeId.toString() === item.recipeId
      );

      if (existing) {
        // Adjust totalCalories: remove old calories, add new
        log.totalCalories -= existing.caloriesConsumed || 0;

        // Overwrite servings + calories (latest selection wins)
        existing.servings = item.servings;
        existing.caloriesConsumed = newCalories;
      } else {
        // New meal for this servingTime + recipeId
        log.meals.push({
          mealType: item.servingTime,
          servingTime: item.servingTime,
          recipeId: item.recipeId,
          servings: item.servings,
          caloriesConsumed: newCalories,
        });
      }

      // Add updated calories to total
      log.totalCalories += newCalories;
    });

    // ✅ Persist changes to DB
    await log.save();

    try {
      const io = req.app.get('io');
      const receiverId = config.defaultDieticianId;
      const senderId = req.user._id;

      const recipeIds = items.map((i) => i.recipeId);
      const recipesInfo = await Recipe.find({ _id: { $in: recipeIds } })
        .select('name image nutrition')
        .lean();

      const totalCaloriesLogged = items.reduce(
        (sum, item) => sum + (item.caloriesConsumed || 0),
        0
      );
      const totalServingsLogged = items.reduce((sum, item) => sum + (item.servings || 0), 0);

      const mealNames = items.map((item) => {
        const recipe = recipesInfo.find((r) => r._id.toString() === item.recipeId.toString());
        return recipe?.name || 'Meal';
      });

      const chatText = isFirstTime
        ? `Logged ${mealNames[0]}${mealNames.length > 1 ? ` and ${mealNames.length - 1} more` : ''} for today`
        : `Updated ${mealNames[0]}${mealNames.length > 1 ? ` and ${mealNames.length - 1} more` : ''}`;

      let conversation = await Conversation.findOne({
        $and: [{ 'participants.userId': senderId }, { 'participants.userId': receiverId }],
      });

      if (!conversation) {
        conversation = await Conversation.create({
          participants: [{ userId: senderId }, { userId: receiverId }],
        });
      }

      const firstRecipe = recipesInfo[0];
      const mealChatMessage = await Chat.create({
        conversationId: conversation._id,
        senderId,
        receiverId,
        message: chatText,
        messageType: 'meal_log',
        attachment: firstRecipe?.image || null,
        metadata: {
          mealLogId: log._id,
          action: isFirstTime ? 'added' : 'updated',
          itemName: mealNames.join(', '),
          calories: totalCaloriesLogged,
          servings: totalServingsLogged,
          servingTime: items[0]?.servingTime || '',
          totalConsumed: log.totalCalories,
        },
      });

      conversation.lastMessage = chatText;
      conversation.lastMessageAt = new Date();
      conversation.participants.forEach((p) => {
        if (p.userId.toString() !== senderId.toString()) p.unreadCount += 1;
      });
      await conversation.save();

      if (io) {
        io.to(`user:${receiverId}`).emit('newMessage', mealChatMessage);
        io.to(`user:${receiverId}`).emit('meal_log_update', {
          patientId: senderId,
          logId: log._id,
          action: isFirstTime ? 'added' : 'updated',
          totalCalories: log.totalCalories,
          mealsCount: log.meals.length,
        });
      }
    } catch (err) {
      console.error('Auto-Chat Error:', err);
    }

    // Recompute summary for all servingTimes from saved log
    const summaryMap = {}; // { [servingTime]: { totalServings, totalCalories } }

    log.meals.forEach((meal) => {
      if (!summaryMap[meal.servingTime]) {
        summaryMap[meal.servingTime] = {
          totalServings: 0,
          totalCalories: 0,
        };
      }
      summaryMap[meal.servingTime].totalServings += meal.servings || 0;
      summaryMap[meal.servingTime].totalCalories += meal.caloriesConsumed || 0;
    });

    return res.status(200).json({
      success: true,
      data: {
        date: targetDate,
        summary: summaryMap,
        addedServings: items.reduce((sum, i) => sum + (i.servings || 0), 0),
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Controller to create a custom food request.
 */
exports.createCustomFoodRequest = async (req, res, next) => {
  try {
    const { date, servingTime, foodName, description, quantityLabel, portion } = req.body || {};

    const file = req.file || null; // image file from multer

    // Validate required fields
    if (!date || !servingTime || !foodName) {
      return res.status(400).json({
        success: false,
        message: 'Date, servingTime, and foodName are required',
      });
    }

    const normalizedDate = normalizeDate(new Date(date));

    // Find the active diet plan using dieticianId
    const dietPlan = await DietPlan.findOne({
      patientId: req.user._id,
      status: 'Active',
    })
      .select('dieticianId')
      .lean();

    if (!dietPlan || !dietPlan.dieticianId) {
      return res.status(404).json({
        success: false,
        message: 'No active diet plan or assigned dietician found',
      });
    }

    // Build imageUrl from saved file (diskStorage)
    let imageUrl = null;
    if (file) {
      imageUrl = `/uploads/${file.filename}`; // adjust base path if needed
    }

    const numericPortion = Number(portion);
    const request = await CustomFoodRequest.create({
      patientId: req.user._id,
      dieticianId: dietPlan.dieticianId,
      date: normalizedDate,
      servingTime,
      imageUrl,
      foodName,
      description: description || '',
      quantityLabel: quantityLabel || null,
      portion: numericPortion > 0 ? numericPortion : 1,
      status: 'Pending',
    });

    // ── Send chat message to dietician ──
    try {
      const io = req.app.get('io');
      const senderId = req.user._id;
      const receiverId = dietPlan.dieticianId;

      const chatText = `Created custom food: ${foodName} (${servingTime})`;

      // Write to old Chat + Conversation collections
      let conversation = await Conversation.findOne({
        $and: [{ 'participants.userId': senderId }, { 'participants.userId': receiverId }],
      });

      if (!conversation) {
        conversation = await Conversation.create({
          participants: [{ userId: senderId }, { userId: receiverId }],
        });
      }

      const chatMessage = await Chat.create({
        conversationId: conversation._id,
        senderId,
        receiverId,
        message: chatText,
        messageType: 'custom_food',
        attachment: imageUrl || null,
        metadata: {
          customFoodRequestId: request._id,
          foodName,
          description: description || '',
          servingTime,
          quantityLabel: quantityLabel || null,
          portion: numericPortion > 0 ? numericPortion : 1,
          date: normalizedDate,
          imageUrl: imageUrl || null,
        },
      });

      conversation.lastMessage = chatText;
      conversation.lastMessageAt = new Date();
      conversation.participants.forEach((p) => {
        if (p.userId.toString() !== senderId.toString()) p.unreadCount += 1;
      });
      await conversation.save();

      // Also write to V1 chat system (MessageV1 + ConversationV1)
      let v1Message = null;
      try {
        const ConversationService = require('../../chat/services/ConversationService');
        const SequenceService = require('../../chat/services/SequenceService');
        const { MessageV1 } = require('../../chat/models');

        const v1Conv = await ConversationService.getOrCreateDirect(
          senderId.toString(),
          receiverId.toString()
        );

        const clientMessageId = `custom_food_${request._id}_${Date.now()}`;
        const serverSeq = await SequenceService.getNextSeq(v1Conv._id.toString());

        v1Message = await MessageV1.create({
          conversationId: v1Conv._id,
          senderId,
          receiverId,
          clientMessageId,
          serverSeq,
          type: 'custom_food',
          content: chatText,
          attachment: imageUrl ? { url: imageUrl } : null,
          customFoodData: {
            foodName,
            description: description || '',
            image: imageUrl || null,
            calories: null,
            protein: null,
            carbs: null,
            fat: null,
            status: 'pending',
            customFoodRequestId: request._id,
          },
        });

        // Update V1 conversation
        await require('../../chat/models').ConversationV1.findByIdAndUpdate(
          v1Conv._id,
          {
            lastMessage: {
              messageId: v1Message._id,
              content: chatText,
              type: 'custom_food',
              senderId,
              createdAt: v1Message.createdAt,
            },
            lastMessageAt: v1Message.createdAt,
            serverSeq,
            $inc: { 'participants.$[other].unreadCount': 1 },
          },
          {
            arrayFilters: [{ 'other.userId': { $ne: senderId } }],
          }
        );
      } catch (v1Err) {
        console.error('V1 chat write error (non-fatal):', v1Err.message);
      }

      if (io) {
        // Emit via V1 format so doctor app picks it up correctly
        if (v1Message) {
          io.to(`user:${receiverId}`).emit('msg.new', {
            message: {
              id: v1Message._id,
              conversationId: v1Message.conversationId,
              senderId: v1Message.senderId,
              receiverId: v1Message.receiverId,
              serverSeq: v1Message.serverSeq,
              type: v1Message.type,
              content: v1Message.content,
              attachment: v1Message.attachment,
              customFoodData: v1Message.customFoodData,
              status: v1Message.status,
              createdAt: v1Message.createdAt,
            },
            conversation_id: v1Message.conversationId.toString(),
          });
        }
        // Also emit legacy events
        io.to(`user:${receiverId}`).emit('newMessage', chatMessage);
        io.to(`user:${receiverId}`).emit('custom_food_update', {
          patientId: senderId,
          requestId: request._id,
          foodName,
          servingTime,
          status: 'Pending',
        });
      }
    } catch (chatErr) {
      console.error('Custom Food Chat Error:', chatErr);
    }

    return res.status(201).json({
      success: true,
      data: {
        requestId: request._id,
        status: request.status,
      },
    });
  } catch (error) {
    next(error);
  }
};

exports.addMealNote = async (req, res, next) => {
  try {
    const { description, servingTime } = req.body;
    const file = req.file;

    const today = normalizeDate(new Date());
    const senderId = req.user._id;
    const receiverId = config.defaultDieticianId;

    let imageUrl = null;
    if (file) {
      const result = await cloudinary.uploader.upload(file.path, {
        folder: cloudinaryUserFolder(senderId, 'meal-notes'),
      });
      imageUrl = result.secure_url;
      await fs.unlink(file.path).catch(() => { });
    }

    if (!description && !imageUrl) {
      return res.status(400).json({
        success: false,
        message: 'Please provide a description or image',
      });
    }

    let conversation = await Conversation.findOne({
      $and: [{ 'participants.userId': senderId }, { 'participants.userId': receiverId }],
    });

    if (!conversation) {
      conversation = await Conversation.create({
        participants: [{ userId: senderId }, { userId: receiverId }],
      });
    }

    const messageText = description || 'Shared a meal photo';
    const mealNoteMessage = await Chat.create({
      conversationId: conversation._id,
      senderId,
      receiverId,
      message: messageText,
      messageType: imageUrl ? 'image' : 'text',
      attachment: imageUrl,
      description: description,
      metadata: {
        action: 'note',
        servingTime: servingTime || '',
      },
    });

    conversation.lastMessage = imageUrl ? '📷 Meal photo' : messageText;
    conversation.lastMessageAt = new Date();
    conversation.participants.forEach((p) => {
      if (p.userId.toString() !== senderId.toString()) p.unreadCount += 1;
    });
    await conversation.save();

    const io = req.app.get('io');
    if (io) {
      io.to(`user:${receiverId}`).emit('newMessage', mealNoteMessage);
    }

    return res.status(201).json({
      success: true,
      data: {
        messageId: mealNoteMessage._id,
        imageUrl,
        description,
        chatMessage: {
          id: mealNoteMessage._id,
          conversationId: mealNoteMessage.conversationId,
          senderId: mealNoteMessage.senderId,
          receiverId: mealNoteMessage.receiverId,
          content: mealNoteMessage.message,
          messageType: mealNoteMessage.messageType === 'image' ? 'meal_log' : 'meal_log',
          attachment: mealNoteMessage.attachment,
          description: mealNoteMessage.description,
          metadata: mealNoteMessage.metadata,
          isRead: false,
          createdAt: mealNoteMessage.createdAt,
        },
      },
    });
  } catch (error) {
    next(error);
  }
};
