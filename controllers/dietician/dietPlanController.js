const mongoose = require('mongoose');
const {
  DietPlan,
  DietPlanRequest,
  FirstConsultation,
  Recipe,
  ManualPaymentProof,
  User,
  MealLog,
} = require('../../models');
const { generateDietPlanWithAI } = require('../../utils/openaiClient');
const {
  buildFirstConsultationPayload,
  flattenPayload,
} = require('../../utils/firstConsultationHelpers');
const {
  calcAge,
  calcBmr,
  calcTdee,
  getNewTabStatusCode,
  mapStatusCodeToLabel,
} = require('../../utils/dieticianPatientHelpers');

const REQUIRED_SERVING_TIMES = [
  'Morning Drink',
  'Breakfast',
  'Brunch',
  'Lunch',
  'Evening Snack',
  'Dinner',
  'Night Drink',
];

const cleanSelectedMeals = (rawSelectedMeals) =>
  (Array.isArray(rawSelectedMeals) ? rawSelectedMeals : []).filter(
    (meal) =>
      meal &&
      typeof meal.servingTime === 'string' &&
      typeof meal.recipeId === 'string' &&
      meal.recipeId.trim().length > 0
  );

/**
 * @desc    List patients for dietician dashboard tabs (New/Ongoing/Past) with pagination, powering both dashboard top-3 and full "See all" lists
 * @route   GET /api/dietician/patients
 * @access  Private (Dietician)
 */
exports.listPatientsForDietician = async (req, res, next) => {
  try {
    const dieticianId = req.user._id;
    const { tab = 'new', page = '1', limit = '10' } = req.query || {};

    const normalizedTab = ['new', 'ongoing', 'past'].includes((tab || '').toLowerCase())
      ? tab.toLowerCase()
      : 'new';

    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const limitParsed = parseInt(limit, 10);
    const limitNum = Math.min(Math.max(Number.isNaN(limitParsed) ? 10 : limitParsed, 1), 100);
    const skip = (pageNum - 1) * limitNum;

    const baseFilter = { dieticianId };
    let filter = { ...baseFilter };

    if (normalizedTab === 'new') {
      filter = {
        ...baseFilter,
        hasActivePlan: false,
        completedAt: null,
      };
    } else if (normalizedTab === 'ongoing') {
      filter = {
        ...baseFilter,
        status: 'Paid',
        hasActivePlan: true,
        completedAt: null,
      };
    } else if (normalizedTab === 'past') {
      filter = {
        ...baseFilter,
        completedAt: { $ne: null },
      };
    }

    const query = DietPlanRequest.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limitNum)
      .populate(
        'patient',
        [
          'profile.fullName',
          'profile.gender',
          'profile.dateOfBirth',
          'profile.imageUrl',
          'healthProfile.weight',
          'healthProfile.height',
          'healthProfile.bmi',
          'healthProfile.activityLevel',
          'healthProfile.primaryGoal',
          'isActive',
        ].join(' ')
      );

    const [total, requests] = await Promise.all([DietPlanRequest.countDocuments(filter), query]);

    const data = requests.map((request) => {
      const patient = request.patient || {};
      const profile = patient.profile || {};
      const healthProfile = patient.healthProfile || {};
      const patientId = patient._id ? patient._id.toString() : null;

      const age = calcAge(profile.dateOfBirth);
      const weight = typeof healthProfile.weight === 'number' ? healthProfile.weight : null;
      const height = typeof healthProfile.height === 'number' ? healthProfile.height : null;
      const bmi = typeof healthProfile.bmi === 'number' ? healthProfile.bmi : null;
      const bmr = calcBmr({ weight, height, age, gender: profile.gender });
      const tdee = calcTdee(bmr, healthProfile.activityLevel);

      if (normalizedTab === 'ongoing') {
        // These will be populated asynchronously below
        return {
          patientId,
          fullName: profile.fullName || null,
          avatarUrl: profile.imageUrl || null,
          weight,
          height,
          bmi,
          primaryGoal: healthProfile.primaryGoal || null,
          activityLevel: healthProfile.activityLevel || null,
          requestId: request._id.toString(),
          isActive: patient.isActive !== false,
        };
      }

      if (normalizedTab === 'past') {
        return {
          patientId,
          fullName: profile.fullName || null,
          avatarUrl: profile.imageUrl || null,
          finalWeight: request.currentWeight ?? null,
          totalKgLost: request.totalKgLost ?? null,
          bmiBefore: request.bmiFrom ?? null,
          bmiAfter: request.bmiTo ?? null,
          completedOn: request.completedAt || null,
        };
      }

      const statusCode = getNewTabStatusCode({
        plansCount: request.plansCount ?? 0,
        hasActivePlan: Boolean(request.hasActivePlan),
        latestPaymentStatus: request.latestPaymentStatus || null,
        status: request.status || 'Unpaid',
      });

      return {
        patientId,
        fullName: profile.fullName || null,
        avatarUrl: profile.imageUrl || null,
        weight,
        bmi,
        bmr,
        tdee,
        statusCode,
        statusLabel: mapStatusCodeToLabel(statusCode),
      };
    });

    // --- Enrich ongoing patients with computed stats ---
    let enrichedData = data;
    if (normalizedTab === 'ongoing' && data.length > 0) {
      const now = new Date();
      // This week: Mon 00:00 to Sun 23:59
      const dow = now.getDay();
      const mondayOffset = dow === 0 ? -6 : 1 - dow;
      const weekStart = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate() + mondayOffset,
        0,
        0,
        0,
        0
      );
      const weekEnd = new Date(weekStart);
      weekEnd.setDate(weekStart.getDate() + 6);
      weekEnd.setHours(23, 59, 59, 999);

      // Days elapsed this week (including today)
      const daysSoFar = Math.min(7, Math.floor((now - weekStart) / (1000 * 60 * 60 * 24)) + 1);

      const patientIds = data.map((d) => d.patientId).filter(Boolean);

      // Batch fetch: active diet plans + this week's meal logs
      const [activePlans, weekLogs] = await Promise.all([
        DietPlan.find({ patientId: { $in: patientIds }, status: 'Active' })
          .sort({ createdAt: -1 })
          .select('patientId activationDate totalCalories calorieStrategy')
          .lean(),
        MealLog.find({
          patientId: { $in: patientIds },
          date: { $gte: weekStart, $lte: weekEnd },
        })
          .select('patientId date totalCalories meals')
          .lean(),
      ]);

      // Index by patientId
      const plansByPatient = {};
      for (const plan of activePlans) {
        const pid = plan.patientId.toString();
        if (!plansByPatient[pid]) plansByPatient[pid] = plan;
      }
      const logsByPatient = {};
      for (const log of weekLogs) {
        const pid = log.patientId.toString();
        if (!logsByPatient[pid]) logsByPatient[pid] = [];
        logsByPatient[pid].push(log);
      }

      enrichedData = data.map((patient) => {
        const pid = patient.patientId;
        const plan = plansByPatient[pid];
        const logs = logsByPatient[pid] || [];

        // Adherence: % of days this week with at least one meal log
        const uniqueLogDays = new Set(
          logs.map((l) => {
            const d = new Date(l.date);
            return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
          })
        );
        const adherencePercent =
          daysSoFar > 0 ? Math.round((uniqueLogDays.size / daysSoFar) * 100) : 0;

        // Progress: startWeight = healthProfile.weight, currentWeight = estimated from calorie data
        const startWeight = patient.weight || 0;
        let currentWeight = startWeight;
        if (plan && logs.length > 0) {
          // Simple: sum total surplus/deficit from activation
          const heightVal = patient.height && patient.height >= 100 ? patient.height : 170;
          const ageEst = 30; // rough estimate since we don't have DOB here
          const bmrEst = patient.weight
            ? 10 * patient.weight + 6.25 * heightVal - 5 * ageEst + 5
            : 1800;
          const actMultiplier = {
            Sedentary: 1.2,
            'Lightly Activity': 1.375,
            'Lightly Active': 1.375,
            'Moderately Activity': 1.55,
            Moderate: 1.55,
            'Very Active': 1.725,
            'Extra Active': 1.9,
          };
          const tdeeEst = bmrEst * (actMultiplier[patient.activityLevel] || 1.55);

          let totalSurplus = 0;
          for (const log of logs) {
            const cal = log.totalCalories || 0;
            totalSurplus += cal - tdeeEst;
          }
          currentWeight = startWeight + totalSurplus / 7700;
          currentWeight = Math.round(currentWeight * 10) / 10;
        }

        // BMI
        const heightM = (patient.height && patient.height >= 100 ? patient.height : 170) / 100;
        const currentBmi =
          currentWeight > 0
            ? Math.round((currentWeight / (heightM * heightM)) * 10) / 10
            : patient.bmi || 0;

        // Trend text
        const weightDiff = currentWeight - startWeight;
        let trendText = 'No change';
        if (weightDiff < -0.2) trendText = `↓ ${Math.abs(weightDiff).toFixed(1)} kg lost`;
        else if (weightDiff > 0.2) trendText = `↑ ${weightDiff.toFixed(1)} kg gained`;

        // Streak: consecutive days with logs ending today
        let streakDays = 0;
        const logDatesSet = new Set(
          logs.map((l) => {
            const d = new Date(l.date);
            return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
          })
        );
        for (let i = 0; i < 7; i++) {
          const checkDate = new Date(now);
          checkDate.setDate(now.getDate() - i);
          const key = `${checkDate.getFullYear()}-${String(checkDate.getMonth() + 1).padStart(2, '0')}-${String(checkDate.getDate()).padStart(2, '0')}`;
          if (logDatesSet.has(key)) {
            streakDays++;
          } else {
            break;
          }
        }

        return {
          patientId: pid,
          fullName: patient.fullName,
          avatarUrl: patient.avatarUrl,
          streakDays,
          trendText,
          progressFromKg: Math.round(startWeight * 10) / 10,
          progressToKg: Math.round(currentWeight * 10) / 10,
          adherencePercent,
          bmiValue: currentBmi,
          isActive: patient.isActive !== false,
        };
      });
    }

    return res.status(200).json({
      success: true,
      data: enrichedData,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        hasMore: skip + requests.length < total,
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Mark a patient's diet plan request as completed, moving them to the Past tab
 * @route   PUT /api/dietician/patients/:requestId/complete
 * @access  Private (Dietician)
 */
exports.markPatientCompleted = async (req, res, next) => {
  try {
    const dieticianId = req.user._id;
    const { requestId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(requestId)) {
      return res.status(400).json({ success: false, message: 'Invalid request ID' });
    }

    const request = await DietPlanRequest.findOne({
      _id: requestId,
      dieticianId,
    }).populate('patient', 'healthProfile.weight healthProfile.height healthProfile.bmi');

    if (!request) {
      return res.status(404).json({ success: false, message: 'Diet plan request not found' });
    }

    if (request.completedAt) {
      return res
        .status(400)
        .json({ success: false, message: 'Patient is already marked as completed' });
    }

    const patient = request.patient || {};
    const healthProfile = patient.healthProfile || {};
    const startWeight = typeof healthProfile.weight === 'number' ? healthProfile.weight : null;
    const startBmi = typeof healthProfile.bmi === 'number' ? healthProfile.bmi : null;
    const heightM = typeof healthProfile.height === 'number' ? healthProfile.height / 100 : null;

    // Try to get the latest weight from meal logs or use the health profile weight
    let finalWeight = startWeight;
    const latestLog = await MealLog.findOne({ patientId: patient._id })
      .sort({ date: -1 })
      .select('totalCalories')
      .lean();

    // If there's an active plan, estimate current weight from calorie data
    if (request.hasActivePlan && startWeight) {
      const activePlan = await DietPlan.findOne({
        patientId: patient._id,
        status: 'Active',
      })
        .select('activationDate')
        .lean();

      if (activePlan && activePlan.activationDate) {
        const logs = await MealLog.find({
          patientId: patient._id,
          date: { $gte: activePlan.activationDate },
        })
          .select('totalCalories')
          .lean();

        if (logs.length > 0) {
          const bmrEst =
            startWeight && heightM ? 10 * startWeight + 6.25 * (heightM * 100) - 5 * 30 + 5 : 1800;
          const tdeeEst = bmrEst * 1.55;
          let totalSurplus = 0;
          for (const log of logs) {
            totalSurplus += (log.totalCalories || 0) - tdeeEst;
          }
          finalWeight = Math.round((startWeight + totalSurplus / 7700) * 10) / 10;
        }
      }
    }

    const finalBmi =
      finalWeight && heightM ? Math.round((finalWeight / (heightM * heightM)) * 10) / 10 : startBmi;

    const totalKgLost =
      startWeight && finalWeight ? Math.round((startWeight - finalWeight) * 10) / 10 : null;

    request.completedAt = new Date();
    request.hasActivePlan = false;
    request.currentWeight = finalWeight;
    request.totalKgLost = totalKgLost;
    request.bmiFrom = startBmi;
    request.bmiTo = finalBmi;
    await request.save();

    // Deactivate any active diet plans for this patient
    await DietPlan.updateMany(
      { patientId: patient._id, status: 'Active' },
      { $set: { status: 'Completed' } }
    );

    return res.status(200).json({
      success: true,
      message: 'Patient marked as completed',
      data: {
        requestId: request._id,
        completedAt: request.completedAt,
        finalWeight,
        totalKgLost,
        bmiBefore: startBmi,
        bmiAfter: finalBmi,
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    List diet plan requests assigned to the logged-in dietician
 * @route   GET /api/dietician/diet-plan-requests
 * @access  Private (Dietician)
 */
exports.listDietPlanRequestsForDietician = async (req, res, next) => {
  try {
    const dieticianId = req.user._id;
    const { status } = req.query || {};

    const filter = { dieticianId };
    if (status) {
      filter.status = status;
    }

    const requests = await DietPlanRequest.find(filter).populate(
      'patient',
      'profile.fullName profile.profileImage healthProfile.primaryGoal'
    );

    const data = requests.map((request) => {
      const patient = request.patient || {};
      const profile = patient.profile || {};
      const healthProfile = patient.healthProfile || {};

      return {
        id: request._id,
        patientId: patient._id || null,
        patientName: profile.fullName || null,
        avatarUrl: profile.profileImage || null,
        primaryGoal: healthProfile.primaryGoal || null,
        startDateForDiet: request.startDateForDiet,
        status: request.status,
        totalAmount: request.totalAmount,
      };
    });

    return res.status(200).json({
      success: true,
      data,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Send a manual payment request notification for a diet plan request
 * @route   POST /api/dietician/patients/:patientId/diet-plan-requests/:requestId/payment-request
 * @access  Private (Dietician)
 */
exports.sendPaymentRequest = async (req, res, next) => {
  try {
    const { patientId, requestId } = req.params;
    const dieticianId = req.user._id;

    if (
      !mongoose.Types.ObjectId.isValid(patientId) ||
      !mongoose.Types.ObjectId.isValid(requestId)
    ) {
      return res.status(400).json({
        success: false,
        message: 'Invalid patient or request id',
      });
    }

    const dietPlanRequest = await DietPlanRequest.findOne({
      _id: requestId,
      patient: patientId,
      dieticianId,
    });

    if (!dietPlanRequest) {
      return res.status(404).json({
        success: false,
        message: 'Diet plan request not found',
      });
    }

    if (dietPlanRequest.status === 'Paid') {
      return res.status(400).json({
        success: false,
        message: 'Payment already completed for this request',
      });
    }

    if (
      dietPlanRequest.status === 'PaymentRequested' ||
      dietPlanRequest.status === 'PaymentSubmitted'
    ) {
      return res.status(400).json({
        success: false,
        message: 'Payment request already sent or awaiting review',
      });
    }

    dietPlanRequest.paymentRequested = true;
    dietPlanRequest.paymentRequestedAt = new Date();
    if (dietPlanRequest.status === 'Unpaid') {
      dietPlanRequest.status = 'PaymentRequested';
    }
    dietPlanRequest.latestPaymentStatus = 'Pending';
    await dietPlanRequest.save({ validateBeforeSave: false });

    await User.findByIdAndUpdate(
      patientId,
      {
        $set: {
          'status.requestId': dietPlanRequest._id,
          'status.requestStatus': dietPlanRequest.status,
          'status.canSendPaymentRequest': false,
          'status.hasPaymentUpdate': false,
        },
      },
      { new: false }
    );

    return res.status(200).json({
      success: true,
      message: 'Payment request sent to patient',
      data: {
        requestId: dietPlanRequest._id,
        status: dietPlanRequest.status,
        paymentRequestedAt: dietPlanRequest.paymentRequestedAt,
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Create a diet plan and immediately generate AI content
 * @route   POST /api/dietician/patients/:patientId/diet-plans/generate
 * @access  Private (Dietician)
 */
exports.createAndGenerateDietPlan = async (req, res, next) => {
  try {
    const { patientId } = req.params;
    const dieticianId = req.user._id;
    const { requestId, firstConsultationId, calorieStrategy, macroStrategy } = req.body;

    if (!mongoose.Types.ObjectId.isValid(patientId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid patient id',
      });
    }

    if (!firstConsultationId || !mongoose.Types.ObjectId.isValid(firstConsultationId)) {
      return res.status(400).json({
        success: false,
        message: 'Valid firstConsultationId is required',
      });
    }

    // requestId is optional — if provided, validate it; otherwise auto-create one
    let dietPlanRequest = null;
    let resolvedRequestId = requestId;

    if (requestId && mongoose.Types.ObjectId.isValid(requestId)) {
      dietPlanRequest = await DietPlanRequest.findById(requestId);
      if (!dietPlanRequest) {
        return res.status(404).json({
          success: false,
          message: 'Diet plan request not found',
        });
      }
      if (dietPlanRequest.patient.toString() !== patientId) {
        return res.status(403).json({
          success: false,
          message: 'Diet plan request does not belong to this patient',
        });
      }
    } else {
      // No requestId provided — find existing or auto-create a DietPlanRequest
      dietPlanRequest = await DietPlanRequest.findOne({ patient: patientId }).sort({
        createdAt: -1,
      });

      if (!dietPlanRequest) {
        dietPlanRequest = await DietPlanRequest.create({
          patient: patientId,
          dieticianId,
          startDateForDiet: new Date(),
          primaryGoal: null,
          status: 'Unpaid',
        });
        console.log('Auto-created DietPlanRequest:', dietPlanRequest._id);
      }
      resolvedRequestId = dietPlanRequest._id;
    }

    const consultation = await FirstConsultation.findById(firstConsultationId);

    if (!consultation) {
      return res.status(404).json({
        success: false,
        message: 'First consultation not found',
      });
    }

    if (consultation.patient.toString() !== patientId) {
      return res.status(403).json({
        success: false,
        message: 'Consultation does not belong to this patient',
      });
    }

    const dietPlan = new DietPlan({
      patientId,
      dieticianId,
      request: resolvedRequestId,
      firstConsultation: firstConsultationId,
      calorieStrategy,
      macroStrategy,
      status: 'Draft',
    });

    await dietPlan.save();

    await dietPlan.populate([
      { path: 'patientId', select: 'profile healthProfile' },
      { path: 'firstConsultation' },
    ]);

    const recipes = await Recipe.find({ dieticianId }).select(
      'name servingTime dietaryHabits freeFrom nutrition _id'
    );

    const recipePool = recipes.map((r) => ({
      id: r._id.toString(),
      name: r.name,
      servingTime: r.servingTime,
      calories: r.nutrition?.calories || null,
      protein: r.nutrition?.protein || null,
      carbs: r.nutrition?.carbs || null,
      fats: r.nutrition?.fats || null,
      dietaryHabits: r.dietaryHabits || {},
      freeFrom: r.freeFrom || {},
    }));

    const generatedText = await generateDietPlanWithAI({
      patient: dietPlan.patientId,
      firstConsultation: dietPlan.firstConsultation,
      calorieStrategy: dietPlan.calorieStrategy,
      macroStrategy: dietPlan.macroStrategy,
      recipes: recipePool,
    });

    dietPlan.generatedPlan = generatedText;
    dietPlan.generatedAt = new Date();
    dietPlan.status = 'Draft';
    await dietPlan.save();

    // Update patient status with requestId if it was auto-created
    await User.findByIdAndUpdate(patientId, {
      $set: {
        'status.requestId': resolvedRequestId.toString(),
        'status.requestStatus': dietPlanRequest.status,
        'status.activeDietPlanId': dietPlan._id.toString(),
      },
    });

    return res.status(201).json({
      success: true,
      data: {
        dietPlanId: dietPlan._id,
        status: dietPlan.status,
        generatedPlan: dietPlan.generatedPlan,
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Get AI generated plan along with recipe details
 * @route   GET /api/dietician/patients/:patientId/diet-plans/:dietPlanId/details
 * @access  Private (Dietician)
 */
exports.getDietPlanDetails = async (req, res, next) => {
  try {
    const { patientId, dietPlanId } = req.params;
    const dieticianId = req.user._id;

    if (
      !mongoose.Types.ObjectId.isValid(patientId) ||
      !mongoose.Types.ObjectId.isValid(dietPlanId)
    ) {
      return res.status(400).json({
        success: false,
        message: 'Invalid patient or diet plan id',
      });
    }

    const dietPlan = await DietPlan.findOne({
      _id: dietPlanId,
      patientId,
      dieticianId,
    });

    if (!dietPlan) {
      return res.status(404).json({
        success: false,
        message: 'Diet plan not found for this patient',
      });
    }

    let parsedPlan;
    try {
      parsedPlan = dietPlan.generatedPlan ? JSON.parse(dietPlan.generatedPlan) : { weeks: [] };
    } catch (err) {
      return res.status(422).json({
        success: false,
        message: 'Generated plan is not valid JSON',
      });
    }

    const recipeIds = new Set();
    parsedPlan?.weeks?.forEach((week) => {
      week?.dailyMeals?.forEach((meal) => {
        if (meal?.recipeId) {
          recipeIds.add(meal.recipeId);
        }
      });
    });

    const recipes = recipeIds.size
      ? await Recipe.find(
        { _id: { $in: Array.from(recipeIds) } },
        { name: 1, nutrition: 1, servings: 1, image: 1, ingredients: 1 }
      )
      : [];

    const recipeMap = {};
    recipes.forEach((recipe) => {
      const id = recipe._id.toString();
      const ingredients = Array.isArray(recipe.ingredients) ? recipe.ingredients : [];

      const totalWeightGrams = ingredients.reduce((sum, ingredient) => {
        const quantity = Number(ingredient?.quantity);
        const unit = (ingredient?.unit || '').toLowerCase();

        if (!Number.isFinite(quantity) || quantity <= 0) {
          return sum;
        }

        if (['g', 'gram', 'grams', 'ml'].includes(unit)) {
          return sum + quantity;
        }

        return sum;
      }, 0);

      const normalizedNutrition = recipe.nutrition || {};

      recipeMap[id] = {
        _id: id,
        name: recipe.name || null,
        image: recipe.image || null,
        totalWeightGrams: totalWeightGrams > 0 ? Math.round(totalWeightGrams) : null,
        nutrition: {
          calories: normalizedNutrition.calories ?? 0,
          protein: normalizedNutrition.protein ?? 0,
          carbs: normalizedNutrition.carbs ?? 0,
          fats: normalizedNutrition.fats ?? 0,
          fiber: normalizedNutrition.fiber ?? 0,
        },
      };
    });

    return res.status(200).json({
      success: true,
      data: {
        dietPlanId: dietPlan._id,
        status: dietPlan.status,
        weeks: parsedPlan.weeks || [],
        recipes: recipeMap,
      },
    });
  } catch (error) {
    next(error);
  }
};
/**
 * @desc    View finalized week selections with recipe options and next-week tags
 * @route   GET /api/dietician/patients/:patientId/diet-plans/:dietPlanId/weeks/:weekNumber
 * @access  Private (Dietician)
 */
exports.getFinalizedWeekDetails = async (req, res, next) => {
  try {
    const { patientId, dietPlanId, weekNumber } = req.params;
    const dieticianId = req.user._id;

    const parsedWeekNumber = Number(weekNumber);
    if (!Number.isInteger(parsedWeekNumber) || parsedWeekNumber < 1 || parsedWeekNumber > 4) {
      return res.status(400).json({
        success: false,
        message: 'weekNumber must be an integer between 1 and 4',
      });
    }

    if (
      !mongoose.Types.ObjectId.isValid(patientId) ||
      !mongoose.Types.ObjectId.isValid(dietPlanId)
    ) {
      return res.status(400).json({
        success: false,
        message: 'Invalid patient or diet plan id',
      });
    }

    const dietPlan = await DietPlan.findOne({
      _id: dietPlanId,
      patientId,
      status: { $in: ['Finalized', 'Active'] }, // Loosened the status filter
    }).lean();

    if (!dietPlan) {
      return res.status(404).json({
        success: false,
        message: 'Diet plan not found for this patient',
      });
    }

    const planWeeks = Array.isArray(dietPlan.finalizedPlan?.weeks)
      ? dietPlan.finalizedPlan.weeks
      : [];
    const currentWeekEntry = planWeeks.find((entry) => entry?.week === parsedWeekNumber);

    if (!currentWeekEntry) {
      return res.status(404).json({
        success: false,
        message: 'This week has not been finalized yet',
      });
    }

    const nextWeekEntry =
      parsedWeekNumber < 4 ? planWeeks.find((entry) => entry?.week === parsedWeekNumber + 1) : null;

    const summaryEntry = Array.isArray(dietPlan.weeksSummary)
      ? dietPlan.weeksSummary.find((entry) => entry?.week === parsedWeekNumber)
      : null;

    const summary = {
      totalCalories: summaryEntry?.totalCalories ?? 0,
      fatPercent: summaryEntry?.fatPercent ?? 0,
      fatGrams: summaryEntry?.fatGrams ?? 0,
      carbPercent: summaryEntry?.carbPercent ?? 0,
      carbGrams: summaryEntry?.carbGrams ?? 0,
      proteinPercent: summaryEntry?.proteinPercent ?? 0,
      proteinGrams: summaryEntry?.proteinGrams ?? 0,
    };

    const selectedByServingTime = {};
    (currentWeekEntry.dailyMeals || []).forEach((meal) => {
      if (meal?.servingTime && meal?.recipeId) {
        selectedByServingTime[meal.servingTime] = meal.recipeId.toString();
      }
    });

    const nextWeekRecipeIds = new Set();
    if (nextWeekEntry && Array.isArray(nextWeekEntry.dailyMeals)) {
      nextWeekEntry.dailyMeals.forEach((meal) => {
        if (meal?.recipeId) {
          nextWeekRecipeIds.add(meal.recipeId.toString());
        }
      });
    }

    const recipeDocs = await Recipe.find({ dieticianId })
      .select('name servingTime nutrition image ingredients servingSize _id') // Added servingSize
      .lean();

    const recipesByServingTime = recipeDocs.reduce((acc, recipe) => {
      const key = recipe.servingTime || 'Other';
      if (!acc[key]) {
        acc[key] = [];
      }
      acc[key].push(recipe);
      return acc;
    }, {});

    const servingTimes = REQUIRED_SERVING_TIMES.map((servingTime) => {
      const selectedRecipeId = selectedByServingTime[servingTime] || null;
      const recipesForTime = (recipesByServingTime[servingTime] || []).map((recipe) => {
        const id = recipe._id.toString();
        return {
          id,
          name: recipe.name || null,
          image: recipe.image || null,
          nutrition: recipe.nutrition || null,
          servingTime: recipe.servingTime || servingTime,
          servingSize: recipe.servingSize || null, // Added servingSize
          isSelected: selectedRecipeId ? id === selectedRecipeId : false,
          nextWeekTag:
            parsedWeekNumber < 4 && nextWeekRecipeIds.has(id)
              ? `Week ${parsedWeekNumber + 1}`
              : null,
        };
      });

      return {
        servingTime,
        selectedRecipeId,
        recipes: recipesForTime,
      };
    });

    return res.status(200).json({
      success: true,
      data: {
        dietPlanId: dietPlan._id,
        week: parsedWeekNumber,
        summary,
        servingTimes,
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Finalize selections for a particular week in a diet plan
 *          Note: Finalizing only locks dietician-side structure. Patient cannot view the diet until activateDietPlan runs.
 * @route   PUT /api/dietician/patients/:patientId/diet-plans/:dietPlanId/finalize-week
 * @access  Private (Dietician)
 */
exports.finalizeWeekPlan = async (req, res, next) => {
  try {
    const { patientId, dietPlanId } = req.params;
    const dieticianId = req.user._id;
    const weekNumber = Number(req.body?.week);
    const { selectedMeals } = req.body || {};

    if (!Number.isInteger(weekNumber) || weekNumber < 1 || weekNumber > 4) {
      return res.status(400).json({
        success: false,
        message: 'week must be an integer between 1 and 4',
      });
    }

    const rawSelectedMeals = Array.isArray(req.body.selectedMeals) ? req.body.selectedMeals : [];

    const cleanedSelectedMeals = cleanSelectedMeals(req.body.selectedMeals);

    const normalizedMeals = REQUIRED_SERVING_TIMES.map((servingTime) => {
      const match = cleanedSelectedMeals.find((meal) => meal.servingTime === servingTime);
      return {
        servingTime,
        recipeId: match ? match.recipeId : null,
      };
    });

    if (
      !mongoose.Types.ObjectId.isValid(patientId) ||
      !mongoose.Types.ObjectId.isValid(dietPlanId)
    ) {
      return res.status(400).json({
        success: false,
        message: 'Invalid patient or diet plan id',
      });
    }

    const dietPlan = await DietPlan.findOne({
      _id: dietPlanId,
      patientId,
      dieticianId,
    }).populate('request');

    if (!dietPlan) {
      return res.status(404).json({
        success: false,
        message: 'Diet plan not found for this patient',
      });
    }

    if (!dietPlan.finalizedPlan || !Array.isArray(dietPlan.finalizedPlan.weeks)) {
      dietPlan.finalizedPlan = { weeks: [] };
    }

    const existingIndex = dietPlan.finalizedPlan.weeks.findIndex(
      (entry) => entry.week === weekNumber
    );
    const weekPayload = {
      week: weekNumber,
      dailyMeals: normalizedMeals,
    };

    if (existingIndex > -1) {
      dietPlan.finalizedPlan.weeks[existingIndex] = weekPayload;
    } else {
      dietPlan.finalizedPlan.weeks.push(weekPayload);
    }

    const summaryPayload = req.body?.summary || {};
    const toNum = (value) => {
      if (value === '' || value === null || value === undefined) {
        return 0;
      }
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : 0;
    };

    const normalizedSummary = {
      week: weekNumber,
      totalCalories: toNum(summaryPayload.totalCalories),
      fatPercent: toNum(summaryPayload.fatPercent),
      fatGrams: toNum(summaryPayload.fatGrams),
      carbPercent: toNum(summaryPayload.carbPercent),
      carbGrams: toNum(summaryPayload.carbGrams),
      proteinPercent: toNum(summaryPayload.proteinPercent),
      proteinGrams: toNum(summaryPayload.proteinGrams),
    };

    if (!Array.isArray(dietPlan.weeksSummary)) {
      dietPlan.weeksSummary = [];
    }

    const summaryIndex = dietPlan.weeksSummary.findIndex((entry) => entry.week === weekNumber);
    if (summaryIndex > -1) {
      dietPlan.weeksSummary[summaryIndex] = normalizedSummary;
    } else {
      dietPlan.weeksSummary.push(normalizedSummary);
    }

    // Promote a still-Draft plan to Finalized once any week is finalized so
    // that it surfaces in getPatientProfile (which filters Finalized/Active).
    if (dietPlan.status === 'Draft') {
      dietPlan.status = 'Finalized';
    }

    dietPlan.markModified('finalizedPlan');
    await dietPlan.save();

    // Auto-send payment request when Week 1 is finalized and status is still Unpaid
    if (weekNumber === 1) {
      const dietPlanRequest = await DietPlanRequest.findOne({
        patient: patientId,
        dieticianId,
      }).sort({ createdAt: -1 });

      if (dietPlanRequest && dietPlanRequest.status === 'Unpaid') {
        dietPlanRequest.status = 'PaymentRequested';
        dietPlanRequest.paymentRequested = true;
        dietPlanRequest.paymentRequestedAt = new Date();
        dietPlanRequest.latestPaymentStatus = 'Pending';
        await dietPlanRequest.save({ validateBeforeSave: false });

        await User.findByIdAndUpdate(patientId, {
          $set: {
            'status.requestStatus': 'PaymentRequested',
            'status.canSendPaymentRequest': false,
            'status.hasPaymentUpdate': false,
          },
        });
      }
    }

    // Update patient weight if provided (for week 2/3/4 recalculations)
    const currentWeight = Number(req.body?.currentWeight);
    if (currentWeight > 0 && Number.isFinite(currentWeight)) {
      const patient = await User.findById(patientId);
      if (patient && patient.healthProfile) {
        patient.healthProfile.weight = currentWeight;
        // Recalculate BMI: weight / (height/100)^2
        const heightM = (patient.healthProfile.height || 170) / 100;
        patient.healthProfile.bmi = parseFloat((currentWeight / (heightM * heightM)).toFixed(1));
        await patient.save();
      }
    }

    return res.status(200).json({
      success: true,
      data: {
        dietPlanId: dietPlan._id,
        finalizedPlan: dietPlan.finalizedPlan,
        summary: normalizedSummary,
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Finalize the entire 4-week diet plan
 *          Note: Finalizing locks all selections but does not expose the diet to the patient until activateDietPlan is called.
 * @route   PUT /api/dietician/patients/:patientId/diet-plans/:dietPlanId/finalize-all
 * @access  Private (Dietician)
 */
exports.finalizeEntireDietPlan = async (req, res, next) => {
  try {
    const { patientId, dietPlanId } = req.params;
    const dieticianId = req.user._id;
    const { weeks } = req.body || {};

    const toNum = (value) => {
      if (value === '' || value === null || value === undefined) {
        return 0;
      }
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : 0;
    };

    if (!Array.isArray(weeks) || weeks.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'weeks must be a non-empty array',
      });
    }

    const weekNumbers = weeks.map((week) => week?.week).filter((week) => typeof week === 'number');
    const invalidWeek = weeks.find(
      (week) => !Number.isInteger(week?.week) || week.week < 1 || week.week > 4
    );

    if (invalidWeek) {
      return res.status(400).json({
        success: false,
        message: 'Each week entry must include a week number between 1 and 4',
      });
    }

    const uniqueWeeks = new Set(weekNumbers);
    if (uniqueWeeks.size !== weeks.length) {
      return res.status(400).json({
        success: false,
        message: 'Duplicate week entries detected',
      });
    }

    const requiredWeeks = [1, 2, 3, 4];
    const missingWeeks = requiredWeeks.filter((required) => !uniqueWeeks.has(required));
    if (missingWeeks.length > 0 || uniqueWeeks.size !== requiredWeeks.length) {
      return res.status(400).json({
        success: false,
        message: 'You must provide selections for weeks 1 through 4',
      });
    }

    if (
      !mongoose.Types.ObjectId.isValid(patientId) ||
      !mongoose.Types.ObjectId.isValid(dietPlanId)
    ) {
      return res.status(400).json({
        success: false,
        message: 'Invalid patient or diet plan id',
      });
    }

    const dietPlan = await DietPlan.findOne({
      _id: dietPlanId,
      patientId,
      dieticianId,
    }).populate('request');

    if (!dietPlan) {
      return res.status(404).json({
        success: false,
        message: 'Diet plan not found for this patient',
      });
    }

    const normalizedWeeks = [];
    const normalizedSummaries = [];

    weeks.forEach((weekEntry) => {
      if (!Array.isArray(weekEntry.dailyMeals)) {
        throw new Error(`Week ${weekEntry.week}: dailyMeals must be an array`);
      }

      const cleanedDailyMeals = cleanSelectedMeals(weekEntry.dailyMeals);

      // Removed validation for missing servingTimes

      const normalizedMeals = REQUIRED_SERVING_TIMES.map((servingTime) => {
        const match = cleanedDailyMeals.find((meal) => meal.servingTime === servingTime);
        return {
          servingTime,
          recipeId: match ? match.recipeId : null,
        };
      });

      normalizedWeeks.push({
        week: weekEntry.week,
        dailyMeals: normalizedMeals,
      });

      const summaryPayload = weekEntry.summary || {};
      normalizedSummaries.push({
        week: weekEntry.week,
        totalCalories: toNum(summaryPayload.totalCalories),
        fatPercent: toNum(summaryPayload.fatPercent),
        fatGrams: toNum(summaryPayload.fatGrams),
        carbPercent: toNum(summaryPayload.carbPercent),
        carbGrams: toNum(summaryPayload.carbGrams),
        proteinPercent: toNum(summaryPayload.proteinPercent),
        proteinGrams: toNum(summaryPayload.proteinGrams),
      });
    });

    dietPlan.finalizedPlan = { weeks: normalizedWeeks };
    dietPlan.weeksSummary = normalizedSummaries;
    dietPlan.status = 'Finalized';
    dietPlan.markModified('finalizedPlan');
    await dietPlan.save();

    // Auto-send payment request to patient after all 4 weeks are finalized
    let paymentRequestSent = false;
    if (dietPlan.request) {
      const dietPlanRequest = await DietPlanRequest.findById(dietPlan.request);
      if (dietPlanRequest && dietPlanRequest.status === 'Unpaid') {
        dietPlanRequest.paymentRequested = true;
        dietPlanRequest.paymentRequestedAt = new Date();
        dietPlanRequest.status = 'PaymentRequested';
        dietPlanRequest.latestPaymentStatus = 'Pending';
        await dietPlanRequest.save({ validateBeforeSave: false });

        await User.findByIdAndUpdate(
          patientId,
          {
            $set: {
              'status.requestId': dietPlanRequest._id,
              'status.requestStatus': 'PaymentRequested',
              'status.canSendPaymentRequest': false,
              'status.hasPaymentUpdate': false,
            },
          },
          { new: false }
        );
        paymentRequestSent = true;
        console.log(
          `Auto-sent payment request to patient ${patientId} after finalizing all 4 weeks`
        );
      }
    }

    return res.status(200).json({
      success: true,
      data: {
        dietPlanId: dietPlan._id,
        status: dietPlan.status,
        finalizedPlan: dietPlan.finalizedPlan,
        weeksSummary: dietPlan.weeksSummary,
        paymentRequestSent,
      },
    });
  } catch (error) {
    if (error.message && error.message.startsWith('Week')) {
      return res.status(400).json({
        success: false,
        message: error.message,
      });
    }
    next(error);
  }
};

/**
 * @desc    Activate a finalized diet plan for a patient after payment verification
 * @route   POST /api/dietician/patients/:patientId/diet-plans/:dietPlanId/activate
 * @access  Private (Dietician)
 */
exports.activateDietPlan = async (req, res, next) => {
  try {
    const { patientId, dietPlanId } = req.params;
    const dieticianId = req.user._id;
    const { proofId, amountReceived, amountPending } = req.body || {};

    let parsedAmountReceived = null;
    let parsedAmountPending = null;

    if (amountReceived !== undefined && amountReceived !== null && amountReceived !== '') {
      parsedAmountReceived = Number(amountReceived);
      if (Number.isNaN(parsedAmountReceived) || parsedAmountReceived < 0) {
        return res.status(400).json({
          success: false,
          message: 'amountReceived must be a valid non-negative number',
        });
      }
    }

    if (amountPending !== undefined && amountPending !== null && amountPending !== '') {
      parsedAmountPending = Number(amountPending);
      if (Number.isNaN(parsedAmountPending) || parsedAmountPending < 0) {
        return res.status(400).json({
          success: false,
          message: 'amountPending must be a valid non-negative number',
        });
      }
    }

    if (
      !mongoose.Types.ObjectId.isValid(patientId) ||
      !mongoose.Types.ObjectId.isValid(dietPlanId)
    ) {
      return res.status(400).json({
        success: false,
        message: 'Invalid patient or diet plan id',
      });
    }

    const dietPlan = await DietPlan.findOne({
      _id: dietPlanId,
      patientId,
      dieticianId,
    }).populate('request');

    if (!dietPlan) {
      return res.status(404).json({
        success: false,
        message: 'Diet plan not found',
      });
    }

    if (dietPlan.status === 'Active') {
      return res.status(400).json({
        success: false,
        message: 'Diet plan is already active',
      });
    }

    if (dietPlan.status !== 'Finalized') {
      return res.status(400).json({
        success: false,
        message: 'Diet plan must be finalized before activation',
      });
    }

    let proofDocument = null;
    const resolvedProofId = proofId || dietPlan.request?.latestPaymentProof;

    if (
      dietPlan.request &&
      dietPlan.request.status === 'PaymentSubmitted' &&
      !resolvedProofId
    ) {
      return res.status(400).json({
        success: false,
        message: 'Payment proof is required before activation',
      });
    }

    if (resolvedProofId) {
      if (!mongoose.Types.ObjectId.isValid(resolvedProofId)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid proof id',
        });
      }

      const proofQuery = {
        _id: resolvedProofId,
        patient: patientId,
      };

      if (dietPlan.request?._id) {
        proofQuery.request = dietPlan.request._id;
      }

      proofDocument = await ManualPaymentProof.findOne(proofQuery);

      if (!proofDocument) {
        return res.status(400).json({
          success: false,
          message: 'Manual payment proof not found for this patient',
        });
      }

      if (proofDocument.status !== 'Submitted') {
        return res.status(400).json({
          success: false,
          message: 'Manual payment proof must be in Submitted status before approval',
        });
      }

      if (parsedAmountReceived !== null) {
        proofDocument.amountReceived = parsedAmountReceived;
      }

      if (parsedAmountPending !== null) {
        proofDocument.amountPending = parsedAmountPending;
      }

      proofDocument.status = 'Approved';
      proofDocument.reviewedBy = dieticianId;
      proofDocument.reviewedAt = new Date();
      await proofDocument.save();
    }

    if (dietPlan.request) {
      if (dietPlan.request.status !== 'Paid') {
        dietPlan.request.status = 'Paid';
      }
      dietPlan.request.hasActivePlan = true;
      dietPlan.request.latestPaymentStatus = 'Paid';
      if (proofDocument) {
        dietPlan.request.latestPaymentProof = proofDocument._id;
        dietPlan.request.collectedAmount = proofDocument.amountReceived || 0;
      }

      // Set subscription validity (30 days from now)
      const now = new Date();
      const expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
      dietPlan.request.subscriptionStartDate = now;
      dietPlan.request.subscriptionExpiresAt = expiresAt;

      await dietPlan.request.save();
    }

    dietPlan.status = 'Active';
    dietPlan.isPaid = true;
    dietPlan.activationDate = dietPlan.activationDate || new Date();
    await dietPlan.save();

    // Compute subscription expiry for user status
    const subscriptionExpiresAt = dietPlan.request?.subscriptionExpiresAt || null;

    const patientStatusUpdate = {
      'status.activeDietPlanId': dietPlan._id,
      'status.canSendPaymentRequest': false,
      'status.hasPaymentUpdate': false,
      'status.subscriptionExpiresAt': subscriptionExpiresAt,
    };

    if (dietPlan.request?._id) {
      patientStatusUpdate['status.requestId'] = dietPlan.request._id;
      patientStatusUpdate['status.requestStatus'] = dietPlan.request.status;
    }

    await User.findByIdAndUpdate(
      patientId,
      {
        $set: patientStatusUpdate,
      },
      { new: false }
    );

    return res.status(200).json({
      success: true,
      message: 'Diet plan activated for patient',
      data: {
        dietPlanId: dietPlan._id,
        status: dietPlan.status,
        requestStatus: dietPlan.request ? dietPlan.request.status : null,
      },
    });
  } catch (error) {
    next(error);
  }
};
