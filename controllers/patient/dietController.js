const { DietPlan, Recipe, MealLog, Chat, Conversation } = require('../../models');
const CustomFoodRequest = require('../../models/CustomFoodRequest');
const config = require('../../config/environment');
const cloudinary = require('../../config/cloudinary');
const { cloudinaryUserFolder } = require('../../utils/cloudinaryFolder');
const { resolveDayGroupForDate, mealMatchesDayGroup } = require('../../utils/dayGroups');
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

const normalizeDate = (dateObj) =>
  new Date(dateObj.getFullYear(), dateObj.getMonth(), dateObj.getDate());

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
        .select('name servingTime nutrition image ingredients servingSize instructions language translations')
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
      // of one flat meal set applying to all 7 days - filter down to just
      // the group referenceDate actually falls into. A meal with no
      // dayGroup (pre-migration plans) matches every group, so old plans
      // keep returning their full unfiltered set exactly as before.
      const todayDayGroup = resolveDayGroupForDate(referenceDate);
      const weekWithFixedMeals = {
        ...week,
        dailyMeals: week.dailyMeals
          .filter((meal) => mealMatchesDayGroup(meal, todayDayGroup))
          .map((meal) => ({
            ...meal,
            recipeId: meal.recipeId || '',
          })),
      };

      return res.status(200).json({
        success: true,
        data: {
          dietPlanId: dietPlan._id,
          status: dietPlan.status,
          activationDate: dietPlan.activationDate || null,
          currentWeek,
          totalWeeks,
          dayGroup: todayDayGroup,
          weekSummary, // single object for the current week
          week: weekWithFixedMeals, // the current week’s dailyMeals with fixed recipeId
          recipes, // keep as-is (all recipes map)
        },
      });
    }
  } catch (error) {
    next(error);
  }
};

/**
 * Maps processed/prepared ingredient names to their raw grocery equivalents.
 * Handles legacy recipes whose ingredients were stored as processed forms
 * (e.g. "Lemon Juice" → "Lemon"). Only the display name is changed; quantity
 * and unit remain as-is so the math stays correct.
 */
const RAW_INGREDIENT_MAP = {
  'lemon juice': { name: 'Lemon', unit: 'piece' },
  'lime juice': { name: 'Lime', unit: 'piece' },
  'orange juice': { name: 'Orange', unit: 'piece' },
  'tomato puree': { name: 'Tomato', unit: null },
  'tomato paste': { name: 'Tomato', unit: null },
  'ginger paste': { name: 'Ginger', unit: null },
  'garlic paste': { name: 'Garlic', unit: null },
  'garlic powder': { name: 'Garlic', unit: null },
  'onion powder': { name: 'Onion', unit: null },
  'ginger powder': { name: 'Ginger', unit: null },
  'chilli powder': { name: 'Red Chilli', unit: null },
  'chili powder': { name: 'Red Chilli', unit: null },
};

/**
 * Returns { name, unit } — replacing known processed forms with their raw store equivalent.
 * If the ingredient is not in the map, returns it unchanged.
 */
const toRawIngredient = (ingredient) => {
  const key = (ingredient.name || '').trim().toLowerCase();
  const mapped = RAW_INGREDIENT_MAP[key];
  if (!mapped) return { name: ingredient.name, unit: ingredient.unit };
  return {
    name: mapped.name,
    unit: mapped.unit !== null ? mapped.unit : ingredient.unit,
  };
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

    // Determine current week FIRST — then only fetch recipes for that week
    const activationStart = parseDateOrNull(dietPlan.activationDate);
    const requestStart = parseDateOrNull(dietPlan.request?.startDateForDiet);
    const startDate = activationStart || requestStart;

    let currentWeek = null;
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
        .select('name servingTime image ingredients')
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

    const groceryMap = {};

    (week.dailyMeals || []).forEach((meal) => {
      const recipe = recipes[meal.recipeId];
      if (!recipe) return;

      recipe.ingredients.forEach((ingredient) => {
        const raw = toRawIngredient(ingredient);
        const key = `${raw.name}|${raw.unit || ''}`;

        if (!groceryMap[key]) {
          groceryMap[key] = {
            name: raw.name,
            unit: raw.unit || null,
            totalQuantity: 0,
            category: ingredient.category || null,
            priceLevel: ingredient.priceLevel || null,
            recipesUsedIn: [],
            purchased: false,
            image: ingredient.image || null,
          };
        }

        if (typeof ingredient.quantity === 'number') {
          groceryMap[key].totalQuantity += ingredient.quantity;
        }

        groceryMap[key].recipesUsedIn.push({
          recipeId: recipe.id,
          recipeName: recipe.name,
          recipeImage: recipe.image || null,
          servingTime: recipe.servingTime || null,
          quantity: typeof ingredient.quantity === 'number' ? ingredient.quantity : null,
        });
      });
    });

    const items = Object.values(groceryMap);

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
      patientId: req.user._id,
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

    const planStartDate = startDate ? normalizeDate(startDate) : null;
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
        totalWeight: recipe.servingSize?.quantity || null,
        totalWeightUnit: recipe.servingSize?.unit || null,
        calories: recipe.nutrition?.calories || 0,
      };
    });

    const activationStart = parseDateOrNull(dietPlan.activationDate);
    const requestStart = parseDateOrNull(dietPlan.request?.startDateForDiet);
    const startDate = activationStart || requestStart;

    let currentWeek = null;
    if (startDate) {
      const startDay = normalizeDate(startDate);
      const diffMs = targetDate.getTime() - startDay.getTime();
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
      (week.dailyMeals || []).forEach((meal) => {
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

        servingTimesMap[meal.servingTime].plannedMeals.push({
          recipeId: recipe.id,
          name: recipe.name,
          image: recipe.image,
          totalWeight: recipe.totalWeight,
          totalWeightUnit: recipe.totalWeightUnit,
          calories: recipe.calories,
          portion: loggedServings, // prefill from MealLog
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
        io.to(receiverId.toString()).emit('newMessage', mealChatMessage);
        io.to(receiverId.toString()).emit('meal_log_update', {
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
          io.to(receiverId.toString()).emit('msg.new', {
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
        io.to(receiverId.toString()).emit('newMessage', chatMessage);
        io.to(receiverId.toString()).emit('custom_food_update', {
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
      io.to(receiverId.toString()).emit('newMessage', mealNoteMessage);
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
