const {
  DietPlan, Recipe, Ingredient, MealLog, Chat, Conversation, Notification, User,
} = require('../../models');
const CustomFoodRequest = require('../../models/CustomFoodRequest');
const { sendPushToTokens } = require('../../utils/push');
const config = require('../../config/environment');
const cloudinary = require('../../config/cloudinary');
const { cloudinaryUserFolder } = require('../../utils/cloudinaryFolder');
const { resolveDayGroupForDate, mealMatchesDayGroup } = require('../../utils/dayGroups');
const { normalize } = require('../../utils/ingredientLibrary');
const { componentRatiosByLabel, computeMealRatio } = require('../../utils/weekNutritionSummary');
const {
  resolvePlanStartDate,
  resolveCurrentWeek,
} = require('../../utils/dietPlanWeek');
const { getFinalizedWeeks } = require('../../utils/dietPlanLegacyView');
const { getOrSetPatientStat, invalidatePatientStats } = require('../../utils/patientStatsCache');
const { buildPlanItemPatientView, baseRecipeIdFromKey } = require('../../utils/dietPlanReadDispatch');
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

// UTC 'YYYY-MM-DD' identifier for the calendar day a (normalizeDate'd) date
// falls on - see MealLog.js's dayKey field. Deliberately not
// toISOString().split('T')[0]: dateObj here is already midnight-UTC from
// normalizeDate, but building it from the UTC getters directly keeps this
// correct even if called on a non-normalized date.
const dateToDayKey = (dateObj) => {
  const year = dateObj.getUTCFullYear();
  const month = String(dateObj.getUTCMonth() + 1).padStart(2, '0');
  const day = String(dateObj.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

/**
 * A renewal cycle can be activated a few days before the running cycle
 * ends (see docwellness-user's 3-day renewal window). While that overlap
 * lasts BOTH DietPlans are status:'Active', and the patient is still
 * living the *older* cycleNumber - so every "the patient's current diet
 * plan" query in this file sorts cycleNumber ascending. This retires the
 * older cycle the moment its last scheduled week has ended, so those
 * queries flip to the new cycle on the right day with no cron. No-op for
 * the normal single-Active-plan case.
 */
const RECIPE_CARD_SELECT =
  'name servingTime nutrition image ingredients servingSize components instructions language translations tags category supplementFacts';

/** Patient-facing Recipe card (same shape getActiveDietPlanForPatient's main
 *  block builds inline) - used to merge the next renewal cycle's recipes
 *  into the continuous Week 1-8 timeline. */
function toPatientRecipeCard(recipe) {
  const id = recipe._id.toString();
  const n = recipe.nutrition || {};
  const nut = {
    calories: n.calories ?? 0,
    protein: n.protein ?? 0,
    carbs: n.carbs ?? 0,
    fats: n.fats ?? 0,
    fiber: n.fiber ?? 0,
  };
  return {
    id,
    name: recipe.name || null,
    servingTime: recipe.servingTime || null,
    image: recipe.image || null,
    tags:
      recipe.category === 'Supplements'
        ? [...(recipe.tags || []), 'supplement']
        : recipe.tags || [],
    supplementFacts: recipe.supplementFacts || null,
    servingSize: {
      servings: 1,
      quantity:
        typeof recipe.servingSize?.quantity === 'number' ? recipe.servingSize.quantity : null,
      unit: recipe.servingSize?.unit || null,
    },
    nutritionPerServing: nut,
    nutrition: nut,
    ingredients: Array.isArray(recipe.ingredients)
      ? recipe.ingredients.map((i) => ({
        id: i._id ? i._id.toString() : undefined,
        name: i.name || null,
        quantity: typeof i.quantity === 'number' ? i.quantity : null,
        unit: i.unit || null,
        image: i.image || null,
        isScalable: typeof i.isScalable === 'boolean' ? i.isScalable : true,
      }))
      : [],
    components: Array.isArray(recipe.components)
      ? recipe.components.map((c) => ({
        label: c.label || null,
        quantity: typeof c.quantity === 'number' ? c.quantity : null,
        unit: c.unit || null,
      }))
      : [],
    instructions: Array.isArray(recipe.instructions) ? recipe.instructions : [],
    language: Array.isArray(recipe.language) ? recipe.language : [recipe.language || 'English'],
    translations: recipe.translations || {},
  };
}

async function retireEndedPredecessorPlans(patientId, now = new Date()) {
  const actives = await DietPlan.find({ patientId, status: 'Active' })
    .select('_id cycleNumber weekSchedule')
    .sort({ cycleNumber: 1 })
    .lean();
  if (actives.length < 2) return;
  const maxCycle = actives[actives.length - 1].cycleNumber || 1;
  const nowMs = now.getTime();
  const ended = actives
    .filter((p) => (p.cycleNumber || 1) < maxCycle)
    .filter((p) => {
      const ws = p.weekSchedule || [];
      if (ws.length === 0) return true;
      return new Date(ws[ws.length - 1].endDate).getTime() < nowMs;
    })
    .map((p) => p._id);
  if (ended.length > 0) {
    await DietPlan.updateMany({ _id: { $in: ended } }, { $set: { status: 'Completed' } });
  }
}

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

    await retireEndedPredecessorPlans(req.user._id, referenceDate);

    // Lowest cycleNumber still Active = the cycle the patient is currently
    // living (a just-activated renewal whose Week 1 hasn't started yet is a
    // higher cycleNumber and stays out of the way until the sweep above
    // flips it in).
    const dietPlan = await DietPlan.findOne({
      patientId: req.user._id,
      status: 'Active',
    })
      .sort({ cycleNumber: 1 })
      .populate('request', 'startDateForDiet')
      .lean();

    if (!dietPlan) {
      return res.status(404).json({
        success: false,
        message: 'Active diet plan not found',
      });
    }

    // v4.0: a 'plan-item' plan has no finalizedPlan blob at all - its
    // dailyMeals/ingredient/supplement data is synthesized from
    // DayPlan/MealSlotPlan/PlanItem/RecipeVersion instead. See
    // utils/dietPlanReadDispatch.js's header comment - this is currently
    // the only one of dietController.js's several getFinalizedWeeks call
    // sites that's been made dataModel-aware.
    let weeks;
    let recipeVersionOverrides = {};
    let planItemSupplementScheduleByWeek = {};
    if (dietPlan.dataModel === 'plan-item') {
      const planItemView = await buildPlanItemPatientView(dietPlan);
      weeks = planItemView.weeks;
      recipeVersionOverrides = planItemView.recipeVersionOverrides;
      planItemSupplementScheduleByWeek = planItemView.supplementScheduleByWeek;
    } else {
      weeks = getFinalizedWeeks(dietPlan);
    }

    // Timed supplements (dosage/instructions/timingAnchor) live in the typed
    // days[] schema (models/DietPlan.js, Phase 1c) - a separate structure
    // from dailyMeals[] entirely, since a plain recipe selection has no
    // timing/dosage fields at all. Only populated for weeks/slots the
    // dietician actually used the wizard's Supplement Injection on (via
    // POST .../supplements) - a plan with none is just an empty list here,
    // same as before this existed. Grouped by week number so it can be
    // attached to both the current week and every entry in `weeks` below,
    // the same way dailyMeals already is.
    const supplementScheduleByWeek = new Map();
    (Array.isArray(dietPlan.days) ? dietPlan.days : []).forEach((day) => {
      const entries = [];
      (day.meals || []).forEach((meal) => {
        (meal.supplements || []).forEach((supplement) => {
          if (!supplement?.supplementId) return;
          entries.push({
            dayGroup: day.dayGroup,
            servingTime: meal.servingTime,
            supplementId: supplement.supplementId.toString(),
            dosage: supplement.dosage || null,
            instructions: supplement.instructions || null,
            timingAnchor: supplement.timingAnchor || 'with',
          });
        });
      });
      if (entries.length === 0) return;
      const existing = supplementScheduleByWeek.get(day.week) || [];
      supplementScheduleByWeek.set(day.week, [...existing, ...entries]);
    });
    // v4.0: dietPlan.days is always empty for a plan-item plan, so the loop
    // above is a no-op for one - merge in the SupplementItem-sourced
    // schedule built above instead.
    Object.entries(planItemSupplementScheduleByWeek).forEach(([week, entries]) => {
      const weekNum = Number(week);
      const existing = supplementScheduleByWeek.get(weekNum) || [];
      supplementScheduleByWeek.set(weekNum, [...existing, ...entries]);
    });

    const recipeIds = new Set();
    weeks.forEach((week) => {
      (week?.dailyMeals || []).forEach((meal) => {
        if (meal?.recipeId) {
          // A plan-item plan's meal.recipeId is versioned (see
          // dietPlanReadDispatch.js's versionedRecipeKey) - resolve back to
          // the real Recipe._id to actually fetch; a no-op for a days-array
          // plan's already-plain id.
          recipeIds.add(baseRecipeIdFromKey(meal.recipeId.toString()));
        }
      });
    });
    for (const entries of supplementScheduleByWeek.values()) {
      entries.forEach((entry) => recipeIds.add(entry.supplementId));
    }

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

    // v4.0: override with the EXACT prescribed ingredients/steps/nutrition
    // for a plan-item plan - the base Recipe fetched above may have been
    // edited since, or this patient's plan may be using a dietician-
    // customized version (V2+) with different quantities than the base
    // recipe's own. servingSize.quantity is pinned to 1 alongside
    // dailyMeals[].servings (see dietPlanReadDispatch.js's header comment)
    // so getRecipesForServing's servings/servingSize.quantity ratio always
    // resolves to exactly 1 - the version's nutritionPerServing below is
    // already the real final number, not something to rescale further.
    // A no-op for every days-array plan (recipeVersionOverrides stays {}).
    // Keyed by versionedRecipeKey (recipeId + versionNumber), NOT the bare
    // recipeId - a clone is created per distinct version rather than
    // overwriting recipes[recipeId] in place, so two occurrences of the same
    // Recipe at different versions (one dietician-edited, one still V1)
    // each keep their own exact prescribed ingredients/nutrition instead of
    // one occurrence's edit silently bleeding into the other's display.
    Object.entries(recipeVersionOverrides).forEach(([versionedId, override]) => {
      const baseRecipe = recipes[override.baseRecipeId];
      if (!baseRecipe) return;
      recipes[versionedId] = {
        ...baseRecipe,
        id: versionedId,
        ingredients: override.ingredients,
        instructions: override.steps,
        nutritionPerServing: override.nutritionPerServing,
        nutrition: override.nutritionPerServing,
        servingSize: { ...baseRecipe.servingSize, quantity: 1 },
        components: override.components,
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
        supplementSchedule: supplementScheduleByWeek.get(Number(week.week)) || [],
      };

      // All weeks the plan actually has, carrying every day-group the same
      // way as the single `week` field above - lets the app fetch once per
      // Diet-tab visit and switch weeks *and* days client-side with no
      // per-tap network round trip. The expensive part (loading
      // finalizedPlan.weeks + resolving every recipe in the plan, above)
      // already happens on every call regardless of which week was
      // requested, so this is close to free.
      const thisCycleOffset = (cycleNumber - 1) * 4;
      const allWeeksData = weeks.map((w) => {
        const weekNum = Number(w.week);
        const scheduleEntry =
          weekScheduleEntries.find((entry) => Number(entry.week) === weekNum) || null;
        const summary = allWeeksSummary.find((s) => Number(s.week) === weekNum) || null;
        return {
          week: weekNum,
          displayWeek: thisCycleOffset + weekNum,
          weekStartDate: scheduleEntry?.startDate || null,
          weekEndDate: scheduleEntry?.endDate || null,
          weekSummary: summary,
          dailyMeals: fixMeals(w.dailyMeals),
          supplementSchedule: supplementScheduleByWeek.get(weekNum) || [],
        };
      });

      // Continuous timeline across a renewal: once the next cycle is Active
      // (built + activated, just not started yet), append its weeks so the
      // patient's Diet tab shows an unbroken Week 1-8 progression instead of
      // the running cycle abruptly stopping at Week 4. `week` on the
      // appended entries is offset (5-8) so switchWeek can address them;
      // their recipes are merged into the same map.
      let mergedWeeks = allWeeksData;
      let mergedTotalWeeks = totalWeeks;
      const nextCycle = await DietPlan.findOne({
        patientId: req.user._id,
        status: 'Active',
        cycleNumber: { $gt: cycleNumber },
      })
        .sort({ cycleNumber: 1 })
        .lean();
      if (nextCycle) {
        const ncOffset = ((nextCycle.cycleNumber || cycleNumber + 1) - 1) * 4;
        let ncWeeks;
        let ncOverrides = {};
        if (nextCycle.dataModel === 'plan-item') {
          const ncView = await buildPlanItemPatientView(nextCycle);
          ncWeeks = ncView.weeks;
          ncOverrides = ncView.recipeVersionOverrides || {};
        } else {
          ncWeeks = getFinalizedWeeks(nextCycle);
        }
        const ncSchedule = Array.isArray(nextCycle.weekSchedule) ? nextCycle.weekSchedule : [];
        const ncSummary = Array.isArray(nextCycle.weeksSummary) ? nextCycle.weeksSummary : [];

        const ncBaseIds = new Set();
        ncWeeks.forEach((w) => (w?.dailyMeals || []).forEach((m) => {
          if (m?.recipeId) ncBaseIds.add(baseRecipeIdFromKey(m.recipeId.toString()));
        }));
        const missingIds = [...ncBaseIds].filter((id) => !recipes[id]);
        if (missingIds.length) {
          const ncDocs = await Recipe.find({ _id: { $in: missingIds } })
            .select(RECIPE_CARD_SELECT)
            .lean();
          ncDocs.forEach((r) => {
            recipes[r._id.toString()] = toPatientRecipeCard(r);
          });
        }
        Object.entries(ncOverrides).forEach(([versionedId, override]) => {
          const base = recipes[override.baseRecipeId];
          if (!base || recipes[versionedId]) return;
          recipes[versionedId] = {
            ...base,
            id: versionedId,
            ingredients: override.ingredients,
            instructions: override.steps,
            nutritionPerServing: override.nutritionPerServing,
            nutrition: override.nutritionPerServing,
            servingSize: { ...base.servingSize, quantity: 1 },
            components: override.components,
          };
        });

        const nextCycleWeeks = ncWeeks.map((w) => {
          const wn = Number(w.week);
          const s = ncSchedule.find((e) => Number(e.week) === wn) || null;
          const sum = ncSummary.find((x) => Number(x.week) === wn) || null;
          return {
            week: ncOffset + wn,
            displayWeek: ncOffset + wn,
            weekStartDate: s?.startDate || null,
            weekEndDate: s?.endDate || null,
            weekSummary: sum,
            dailyMeals: fixMeals(w.dailyMeals),
            supplementSchedule: [],
          };
        });
        mergedWeeks = [...allWeeksData, ...nextCycleWeeks];
        mergedTotalWeeks = mergedWeeks.length;
      }

      return res.status(200).json({
        success: true,
        data: {
          dietPlanId: dietPlan._id,
          status: dietPlan.status,
          activationDate: dietPlan.activationDate || null,
          currentWeek,
          totalWeeks: mergedTotalWeeks,
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
          weeks: mergedWeeks, // every week (this cycle + any next renewal cycle), for client-side caching
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
    })
      .sort({ cycleNumber: 1 })
      .lean();
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

    const weeks = getFinalizedWeeks(dietPlan);
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
 * Aggregates one week's dailyMeals into the grocery-item shape the app
 * renders (name/unit/totalQuantity/displayQuantity/category/recipesUsedIn),
 * merging by canonical ingredient name via the shared registry. Extracted
 * so getGroceriesForCurrentWeek can call this once per ready week - see that
 * function's own doc comment for why it now aggregates every week, not just
 * the current one, in a single response.
 */
const buildGroceryItemsForWeek = (week, recipes, registry) => {
  const groceryMap = {};

  (week.dailyMeals || []).forEach((meal) => {
      const recipe = recipes[meal.recipeId];
      if (!recipe) return;

      // Scales each ingredient by whichever recipe component it matches
      // (by name, same convention as the dietician app's own Edit Portions
      // -> Ingredients sync) - without this, a portion the dietician
      // adjusted for this specific patient's meal (e.g. Brown Bread bumped
      // to 2 slices via the component stepper) was silently ignored here,
      // and the grocery list always showed the recipe's raw default
      // ingredient quantity/unit instead. Unmatched ingredients (no
      // same-named component) fall through at ratio 1, unscaled - same as
      // before this fix.
      const componentRatios = componentRatiosByLabel(meal, recipe);

      recipe.ingredients.forEach((rawIngredient) => {
        const ratioKey = (rawIngredient.name || '').trim().toLowerCase();
        const ratio = componentRatios[ratioKey] ?? 1;
        const ingredient = typeof rawIngredient.quantity === 'number' && ratio !== 1
          ? { ...rawIngredient, quantity: rawIngredient.quantity * ratio }
          : rawIngredient;
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

  return items;
};

/**
 * @route   GET /api/patient/diet/groceries
 * @desc    Grocery list for every week the dietician has actually finalized
 *          (finalizedPlan.weeks - a locked/not-yet-generated future week has
 *          no entry there and is simply omitted, same "is this week ready"
 *          check the endpoint always used internally, now surfaced as the
 *          set of weeks returned instead of silently returning an empty
 *          list for whichever single week `date` fell into). Returns every
 *          ready week's items in ONE response so the app can prefetch all
 *          of them on first load and switch weeks client-side with zero
 *          repeat calls (see GroceryController.switchWeek) - the same
 *          all-weeks-in-one-response pattern getActiveDietPlanForPatient
 *          already uses for the diet plan itself.
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
      .sort({ cycleNumber: 1 })
      .populate('request', 'startDateForDiet')
      .lean();

    if (!dietPlan) {
      return res.status(404).json({
        success: false,
        message: 'Active diet plan not found',
      });
    }

    // currentWeek is just a hint for which week the app should default its
    // selector to - readiness itself is decided per-week below by which
    // weeks are actually present in finalizedPlan.weeks.
    const currentWeek = resolveCurrentWeek(dietPlan, referenceDate);

    const readyWeeks = getFinalizedWeeks(dietPlan);
    if (readyWeeks.length === 0) {
      return res.status(200).json({
        success: true,
        data: { currentWeek, weeks: [] },
      });
    }

    // Recipe/registry resolution done once across every ready week's
    // recipes combined (not once per week) - the same economy of scale
    // getActiveDietPlanForPatient's all-weeks response already relies on.
    const recipeIds = new Set();
    readyWeeks.forEach((week) => {
      (week.dailyMeals || []).forEach((meal) => {
        if (meal?.recipeId) recipeIds.add(meal.recipeId.toString());
      });
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

    const weeksData = readyWeeks
      .map((week) => ({
        week: Number(week.week),
        items: buildGroceryItemsForWeek(week, recipes, registry),
      }))
      .sort((a, b) => a.week - b.week);

    return res.status(200).json({
      success: true,
      data: { currentWeek, weeks: weeksData },
    });
  } catch (error) {
    next(error);
  }
};

exports.getTodayMealLogStats = async (req, res, next) => {
  try {
    const queryDate = req.query.date;
    const today = queryDate ? normalizeDate(new Date(queryDate)) : normalizeDate(new Date());

    // Cross-app performance optimization, task 2.6: this whole computation
    // (DietPlan + MealLog + Recipe fetch + per-meal ratio math) is cached
    // per patient + day for a short window. The patient's own meal-log
    // writes wipe it immediately (see invalidatePatientStats call sites),
    // so their view is never stale to their own actions; the TTL is the
    // backstop for dietician-side plan/recipe edits.
    const dayKey = today.toISOString().slice(0, 10);
    const cacheKey = `pstat:mealtoday:${req.user._id}:${dayKey}`;
    const result = await getOrSetPatientStat(
      String(req.user._id),
      cacheKey,
      120,
      () => computeTodayMealLogStats(req.user._id, today)
    );

    if (result && result.noPlan) {
      return res.status(404).json({ success: false, message: 'Active diet plan not found' });
    }
    return res.status(200).json({ success: true, data: result.data });
  } catch (error) {
    next(error);
  }
};

/**
 * The body of GET /meal-log/today-stats, extracted so getTodayMealLogStats
 * can cache it (task 2.6). Returns `{ noPlan: true }` or `{ data: {...} }`.
 */
async function computeTodayMealLogStats(patientId, today) {
  await retireEndedPredecessorPlans(patientId);
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
    // weeks the same way getActiveDietPlanForPatient does. Without this the
    // Home "Your progress" card showed 0 planned calories and 0/0g macro
    // goals for every plan-item patient (getFinalizedWeeks returned []).
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

  // A plan-item meal.recipeId is a versioned key ("<id>::v2"); resolve it
  // back to the real Recipe._id to fetch (a no-op for a days-array plan).
  const recipeIds = new Set();
  todaysDailyMeals.forEach((meal) => {
    if (meal?.recipeId) recipeIds.add(baseRecipeIdFromKey(meal.recipeId.toString()));
  });

  const existingLog = await MealLog.findOne({
    patientId: patientId,
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
      // Raw shape computeMealRatio (utils/weekNutritionSummary.js) needs -
      // servingSize/secondaryComponent/components as stored, not flattened
      // to a single baseQuantity. That single-quantity/single-ratio
      // shortcut (assignedQuantity / baseQuantity, applied uniformly to
      // the whole recipe) was this endpoint's own reimplementation and
      // silently ignored componentServings/secondaryServings on any
      // multi-component recipe (e.g. a fruit + nuts combo where only the
      // nuts portion was adjusted) - ratio is now computed the same way
      // everywhere else in the app (the dietician app's own live "Total
      // Budget" preview, and this same computeMealRatio at finalize time),
      // instead of a fourth, drifted approximation just for this screen.
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
  // below reads it straight with no ratio scaling. No-op for a days-array
  // plan (recipeVersionOverrides stays {}).
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
  // that must apply to every calorie/macro number below (planned and
  // consumed alike) instead of the recipe's raw, unscaled base nutrition.
  // computeMealRatio averages every component's own (assigned/base) ratio
  // (falling back to meal.servings/secondaryServings for components 0/1 on
  // an older meal without componentServings) - the same formula the
  // dietician app's PatientsController._nutritionScaleRatio and this
  // backend's own finalize-time weeksSummary already use, so this screen's
  // numbers can't drift from either of those again.
  const assignedRatioByKey = {};
  todaysDailyMeals.forEach((meal) => {
    const recipe = recipes[meal.recipeId];
    if (!recipe) return;
    const baseId = baseRecipeIdFromKey(meal.recipeId.toString());
    // A plan-item meal's version nutrition is already the exact prescribed
    // amount (servings is always 1) - ratio 1, no scaling. computeMealRatio
    // would divide by the version's own component quantities and skew it.
    const ratio = isPlanItem ? 1 : computeMealRatio(meal, recipe);
    assignedRatioByKey[`${meal.servingTime}:${recipe.id}`] = ratio;
    assignedRatioByKey[`${meal.servingTime}:${baseId}`] = ratio;  // logged meals key on the base id
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

  return {
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
  };
}

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
      .sort({ cycleNumber: 1 })
      .populate('request', 'startDateForDiet')
      .lean();

    if (!dietPlan) {
      return res.status(404).json({
        success: false,
        message: 'Active diet plan not found',
      });
    }

    // v4.0: a 'plan-item' plan has no finalizedPlan blob - its weeks are
    // synthesized from DayPlan/MealSlotPlan/PlanItem/RecipeVersion, same as
    // getActiveDietPlanForPatient does. Without this branch getFinalizedWeeks
    // returned [] for a plan-item patient, so `week` below resolved to null
    // and the Log Meal sheet showed "No meals" on every tab.
    let weeks;
    let recipeVersionOverrides = {};
    if (dietPlan.dataModel === 'plan-item') {
      const planItemView = await buildPlanItemPatientView(dietPlan);
      weeks = planItemView.weeks;
      recipeVersionOverrides = planItemView.recipeVersionOverrides;
    } else {
      weeks = getFinalizedWeeks(dietPlan);
    }

    // A plan-item plan's meal.recipeId is a versioned key ("<id>::v2" - see
    // utils/dietPlanReadDispatch.js); baseRecipeIdFromKey resolves it back to
    // the real Recipe._id to fetch (a no-op for a days-array plan's plain id).
    const recipeIds = new Set();
    weeks.forEach((week) => {
      (week?.dailyMeals || []).forEach((meal) => {
        if (meal?.recipeId) {
          recipeIds.add(baseRecipeIdFromKey(meal.recipeId.toString()));
        }
      });
    });

    const recipeDocs = recipeIds.size
      ? await Recipe.find({ _id: { $in: Array.from(recipeIds) } })
        .select('name image servingSize secondaryComponent components nutrition')
        .lean()
      : [];

    const recipes = {};
    recipeDocs.forEach((recipe) => {
      const id = recipe._id.toString();
      recipes[id] = {
        id,
        name: recipe.name || null,
        image: recipe.image || null,
        // Raw shape computeMealRatio (utils/weekNutritionSummary.js) needs -
        // see getTodayMealLogStats' own identical fix above for why a
        // single baseQuantity/ratio here silently ignored componentServings/
        // secondaryServings on a multi-component recipe.
        servingSize: recipe.servingSize || null,
        secondaryComponent: recipe.secondaryComponent || null,
        components: recipe.components || null,
        totalWeightUnit: recipe.servingSize?.unit || null,
        baseCalories: recipe.nutrition?.calories || 0,
      };
    });

    // v4.0: mirror getActiveDietPlanForPatient - synthesize a per-version
    // recipes entry (keyed by the same versioned id dailyMeals uses) from the
    // dietician-customized RecipeVersion, so the sheet shows the exact
    // prescribed calories and the recipeId it echoes back on submit is the
    // one the Diet Plan screen already handed the app. The version's
    // nutritionPerServing is already the final prescribed number (servings is
    // always 1), so the plannedMeals loop below skips ratio scaling for it.
    // A no-op for a days-array plan (recipeVersionOverrides stays {}).
    Object.entries(recipeVersionOverrides).forEach(([versionedId, override]) => {
      const baseRecipe = recipes[override.baseRecipeId];
      if (!baseRecipe) return;
      recipes[versionedId] = {
        ...baseRecipe,
        id: versionedId,
        baseCalories: override.nutritionPerServing?.calories ?? baseRecipe.baseCalories,
        components: override.components || baseRecipe.components,
        servingSize: { ...(baseRecipe.servingSize || {}), quantity: 1 },
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

        // MealLog stores the real Recipe._id (submitMealLog normalizes the
        // versioned key on write), so match logged entries against the base
        // id - a no-op for a days-array plan.
        const baseId = baseRecipeIdFromKey(meal.recipeId.toString());
        const isVersioned = baseId !== meal.recipeId.toString();
        const key = `${meal.servingTime}:${baseId}`;
        const loggedServings = loggedMap[key] || 0; // 0 if not logged yet

        // Show what the dietician actually assigned (dailyMeals[].servings,
        // e.g. 75g) and its correctly-scaled calories, not the recipe's raw
        // base serving/calories. computeMealRatio (not a single servings/
        // baseQuantity ratio) so a multi-component recipe's secondary/
        // component-level adjustments are reflected too - same formula as
        // getTodayMealLogStats and the dietician app's own live preview.
        // A plan-item meal's version nutrition is already the exact prescribed
        // amount (servings is always 1) - no further scaling.
        const assignedQuantity = isVersioned
          ? (recipe.servingSize?.quantity ?? 1)
          : (meal.servings ?? recipe.servingSize?.quantity ?? 1);
        const ratio = isVersioned ? 1 : computeMealRatio(meal, recipe);

        servingTimesMap[meal.servingTime].plannedMeals.push({
          recipeId: meal.recipeId.toString(),
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

    // Reject only if the target date is in the future - a patient logs what
    // they *did* eat, which can only ever be today or an earlier day (see
    // DietController.isDateLoggable/diet_view.dart's day strip, which
    // already only ever offers today-or-past dates for logging). This used
    // to reject the opposite direction (`targetDate < today`), which
    // blocked every legitimate past-day submission with "Cannot modify past
    // meal logs" and had no effect on the real bug: since the app's
    // sendLogMeal() always sent today's date regardless of which day was
    // selected, a past-day log always silently landed on today's document
    // instead of being rejected or saved to the right day.
    if (targetDate > today) {
      return res.status(400).json({
        success: false,
        message: 'Cannot log a meal for a future date',
      });
    }

    // Validate items
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Items must be a non-empty array',
      });
    }

    // v4.0: a plan-item plan's diet response hands the app *versioned* recipe
    // keys ("<recipeId>::v2" - see utils/dietPlanReadDispatch.js) as the
    // opaque recipeId, and that is the only id the app has to send back here.
    // Resolve each to the real Recipe._id before validation/storage - without
    // this every log from a plan-item patient failed ObjectId.isValid below
    // with "Invalid item in items array" ("Could not log this meal" in-app).
    // A no-op for a days-array plan's already-plain ids.
    items.forEach((item) => {
      if (item && item.recipeId != null) {
        item.recipeId = baseRecipeIdFromKey(String(item.recipeId));
      }
    });

    for (const item of items) {
      // servings === 0 is a valid, deliberate "un-log this item" signal
      // (see below) - only negative/non-numeric values are actually
      // invalid.
      if (
        !item.servingTime ||
        !mongoose.Types.ObjectId.isValid(item.recipeId) ||
        typeof item.servings !== 'number' ||
        item.servings < 0
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
        dayKey: dateToDayKey(targetDate),
        meals: [],
        totalCalories: 0,
      });
    } else if (!log.dayKey) {
      // Backfill on first touch for a pre-dayKey document.
      log.dayKey = dateToDayKey(targetDate);
    }

    // Overwrite-or-append per (servingTime, recipeId) - servings === 0
    // means the patient explicitly set an already-logged item's portion
    // back down to 0 to un-log it (see docwellness-user's
    // LogMealContainer/CustomPortionDropDown), so it removes that entry
    // outright instead of writing a zero-servings row.
    items.forEach((item) => {
      const newCalories = item.caloriesConsumed || 0;

      const existingIndex = log.meals.findIndex(
        (meal) =>
          meal.servingTime === item.servingTime &&
          meal.recipeId &&
          meal.recipeId.toString() === item.recipeId
      );
      const existing = existingIndex >= 0 ? log.meals[existingIndex] : null;

      if (item.servings === 0) {
        if (existing) {
          log.totalCalories -= existing.caloriesConsumed || 0;
          log.meals.splice(existingIndex, 1);
        }
        return;
      }

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

    // The patient's own meal-log changed - drop their cached stat windows so
    // their Home/Diet screens reflect it immediately (task 2.6).
    await invalidatePatientStats(req.user._id);

    try {
      const io = req.app.get('io');
      const receiverId = config.defaultDieticianId;
      const senderId = req.user._id;

      // Un-logs (servings === 0, see above) shouldn't read as
      // "Logged"/"Updated" in the dietician-facing chat summary - skip the
      // whole notification when a submission was nothing but un-logs
      // (nothing was actually added or changed for the dietician to see).
      const loggedItems = items.filter((i) => i.servings > 0);

      if (loggedItems.length > 0) {
        const recipeIds = loggedItems.map((i) => i.recipeId);
        const recipesInfo = await Recipe.find({ _id: { $in: recipeIds } })
          .select('name image nutrition')
          .lean();

        const totalCaloriesLogged = loggedItems.reduce(
          (sum, item) => sum + (item.caloriesConsumed || 0),
          0
        );
        const totalServingsLogged = loggedItems.reduce((sum, item) => sum + (item.servings || 0), 0);

        const mealNames = loggedItems.map((item) => {
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
            servingTime: loggedItems[0]?.servingTime || '',
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
        }

        // The dietician gets a real bell notification + best-effort OS push
        // when a patient logs a meal - the socket 'newMessage'/'meal_log_update'
        // events above only reach an app that's open on this conversation.
        // Mirrors chatController.sendMessage's own notify block.
        try {
          const patient = await User.findById(senderId).select('profile.fullName deviceTokens').lean();
          const patientName = patient?.profile?.fullName || 'A patient';
          const notifTitle = `${patientName} logged a meal`;
          const notifBody = `${chatText} · ${Math.round(totalCaloriesLogged)} kcal`;
          const notif = await Notification.create({
            userId: receiverId,
            title: notifTitle,
            message: notifBody,
            type: 'progress',
            referenceId: conversation._id,
            referenceModel: 'Chat',
          });
          if (io) {
            io.to(`user:${receiverId}`).emit('notification.new', {
              id: notif._id,
              title: notif.title,
              message: notif.message,
              type: notif.type,
              referenceId: notif.referenceId?.toString(),
              createdAt: notif.createdAt,
            });
          }
          const dietician = await User.findById(receiverId).select('deviceTokens').lean();
          const tokens = (dietician?.deviceTokens || []).map((t) => t.token);
          sendPushToTokens(
            tokens,
            {
              title: notifTitle,
              body: notifBody,
              data: {
                deepLink: 'docwellness://logged-data',
                patientId: String(senderId),
              },
            },
            (deadToken) => {
              User.updateOne(
                { _id: receiverId },
                { $pull: { deviceTokens: { token: deadToken } } }
              ).catch(() => {});
            }
          );
        } catch (notifErr) {
          console.error('Meal-log dietician notification error (non-fatal):', notifErr);
        }
      }

      if (io) {
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
      .sort({ cycleNumber: 1 })
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
