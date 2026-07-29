const crypto = require('crypto');
const mongoose = require('mongoose');
const {
  DietPlan,
  DietPlanRequest,
  FirstConsultation,
  Recipe,
  ManualPaymentProof,
  User,
  MealLog,
  GenerationLog,
} = require('../../models');
const config = require('../../config/environment');
const { generateDietPlanWithAI } = require('../../utils/openaiClient');
const { seedGoalTimeline } = require('../../utils/seedGoalTimeline');
const { parsePagination, buildPaginationMeta } = require('../../utils/pagination');
const {
  buildFirstConsultationPayload,
  flattenPayload,
} = require('../../utils/firstConsultationHelpers');
const {
  calcAge,
  calcBmr,
  calcTdee,
  calcProteinTargetG,
  getNewTabStatusCode,
  mapStatusCodeToLabel,
} = require('../../utils/dieticianPatientHelpers');
const {
  mapEatingStyleToDietFlag,
  findAllergenConflicts,
  getConsultationAnswer,
} = require('../../utils/dietaryConstraintValidator');
const { validateDietPlan, formatSevereIssuesForPrompt, SEVERE_CALORIE_DEVIATION_TOLERANCE } = require('../../utils/dietPlanValidator');
const { repairStructuralIssues, REPAIRABLE_SEVERE_ISSUE_TYPES } = require('../../utils/dietPlanRepair');
const { computeFinalizeBlockingIssues } = require('../../utils/dietPlanFinalizeChecks');
const { checkTextSafety } = require('../../utils/inputGuardrails');
const { SAFETY_FIELD_IDS } = require('../../utils/consultationFormSeed');
const { logWeight } = require('../../utils/weightLog');
const {
  getMembershipTier,
  TIER_INITIAL_WEEKS,
  validateRegenerateRequest,
} = require('../../utils/membershipTiers');
const {
  buildServingTimeOptions,
  buildDayGroupsOptions,
  fetchRecipePoolForOptions,
  buildRecipesByServingTimeMap,
  SIDE_SALAD_ELIGIBLE_SLOTS,
} = require('../../utils/dietPlanOptions');
const { DAY_GROUPS, mealMatchesDayGroup } = require('../../utils/dayGroups');
const { computeWeekSummary } = require('../../utils/weekNutritionSummary');
const { buildWeekSchedule, cascadeWeekScheduleFrom } = require('../../utils/weekSchedule');

const REQUIRED_SERVING_TIMES = [
  'Morning Drink',
  'Breakfast',
  'Brunch',
  'Lunch',
  'Evening Snack',
  'Dinner',
  'Night Drink',
];

// servings mirrors the field name/semantics the patient's own meal-logging
// flow already uses (see controllers/patient/dietController.js's
// `m.servings || 1` multiplications) - how much of this recipe the
// dietician actually prescribed for this slot (e.g. 3 chapatis, or 400g of
// Chole), not just whether it was picked. Defaults to 1 so older payloads
// without it (or a bad value) still behave exactly as before.
const cleanSelectedMeals = (rawSelectedMeals) =>
  (Array.isArray(rawSelectedMeals) ? rawSelectedMeals : [])
    .filter(
      (meal) =>
        meal &&
        typeof meal.servingTime === 'string' &&
        typeof meal.recipeId === 'string' &&
        meal.recipeId.trim().length > 0 &&
        DAY_GROUPS.includes(meal.dayGroup)
    )
    .map((meal) => ({
      dayGroup: meal.dayGroup,
      servingTime: meal.servingTime,
      recipeId: meal.recipeId,
      servings: typeof meal.servings === 'number' && meal.servings > 0 ? meal.servings : 1,
      // Only meaningful for recipes with a secondaryComponent (e.g. the
      // seeds/chikki mix-in alongside a fruit) - omitted (not defaulted to
      // 1) for every ordinary recipe so it doesn't show up as spurious data.
      ...(typeof meal.secondaryServings === 'number' && meal.secondaryServings > 0
        ? { secondaryServings: meal.secondaryServings }
        : {}),
      // Generalizes servings/secondaryServings to however many components
      // the recipe actually has (see models/Recipe.js's `components`) -
      // index N here is recipe.components[N]'s selected quantity. Omitted
      // for a recipe still only using the legacy 1-2 slot shape, or a meal
      // whose selection hasn't been re-saved through the components-aware
      // app yet - weekNutritionSummary.js falls back to servings/
      // secondaryServings when this is absent.
      ...(Array.isArray(meal.componentServings) &&
        meal.componentServings.every((n) => typeof n === 'number' && n > 0)
        ? { componentServings: meal.componentServings }
        : {}),
    }));

// 'Weight Loss'/'Fat Loss' -> smaller default portions; every other goal
// (Weight Gain, Muscle Gain, Weight Maintenance, Healthy Weight Management)
// -> the less-restrictive weight-gain-style portions, since none of those
// are actively cutting calories. Drives the dietician app's trend-aware
// sabji/side/salad default quantities and stepper clamps (patients_
// controller.dart) - purely a display/default concern, not persisted.
const LOSS_GOALS = new Set(['Weight Loss', 'Fat Loss']);
async function resolveWeightTrend(patientId) {
  const patient = await User.findById(patientId).select('healthProfile.primaryGoal').lean();
  const primaryGoal = patient?.healthProfile?.primaryGoal;
  return LOSS_GOALS.has(primaryGoal) ? 'loss' : 'gain';
}

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

    // "Ongoing" should mean the diet has actually started, not just that a
    // plan was activated/paid for - a patient can be fully paid days before
    // their week 1 begins (see weekSchedule), and until then there's
    // nothing "ongoing" to review yet. Patients with an active plan whose
    // week 1 hasn't started stay in "new" instead. Falls back to treating a
    // plan as already-started if it predates weekSchedule (no week-1 entry
    // to check), preserving old behavior for those.
    let notStartedPatientIds = [];
    if (normalizedTab === 'new' || normalizedTab === 'ongoing') {
      const now = new Date();
      const activePlans = await DietPlan.find({ dieticianId, status: 'Active' })
        .select('patientId weekSchedule')
        .lean();
      notStartedPatientIds = activePlans
        .filter((plan) => {
          const week1 = (plan.weekSchedule || []).find((w) => w.week === 1);
          return week1 && new Date(week1.startDate) > now;
        })
        .map((plan) => plan.patientId);
    }

    const baseFilter = { dieticianId };
    let filter = { ...baseFilter };

    if (normalizedTab === 'new') {
      filter = {
        ...baseFilter,
        completedAt: null,
        $or: [
          { hasActivePlan: false },
          { hasActivePlan: true, patient: { $in: notStartedPatientIds } },
        ],
      };
    } else if (normalizedTab === 'ongoing') {
      filter = {
        ...baseFilter,
        // PartiallyPaid patients are still activated/active (see
        // activateDietPlan) with just an outstanding balance - they belong
        // in "ongoing", not stuck out of every tab. Same for PaymentSubmitted
        // with hasActivePlan already true - that's a renewal/balance payment
        // under review, not a fresh signup; their existing plan is still
        // live, so they'd otherwise vanish from every tab (not "new" since
        // hasActivePlan is true, not "ongoing" since status isn't
        // Paid/PartiallyPaid, not "past" since nothing completed).
        //
        // status is intentionally unrestricted (any non-null value) rather
        // than an explicit $in list: starting a renewal (see
        // startRenewal()) resets status back to 'Unpaid'/'PaymentRequested'
        // on the *same* request while hasActivePlan stays true (the prior
        // cycle's plan is still live/loggable until the new one activates)
        // - that combination doesn't match any status this list used to
        // enumerate, and would otherwise make a renewing patient vanish
        // from every tab the same way PaymentSubmitted once did above.
        status: { $ne: null },
        hasActivePlan: true,
        completedAt: null,
        patient: { $nin: notStartedPatientIds },
      };
    } else if (normalizedTab === 'past') {
      filter = {
        ...baseFilter,
        completedAt: { $ne: null },
      };
    }

    // One row per *patient*, not per request document. A patient can
    // legitimately end up with more than one DietPlanRequest (a renewal
    // reuses the same one, but nothing at the schema level enforces that -
    // e.g. a retried/duplicate signup, or admin/test tooling creating a
    // second one) - a plain find() showed one row per matching document,
    // so any such patient appeared twice in this list. $group on `patient`
    // (keeping each patient's most-recently-created matching request, since
    // the collection is pre-sorted newest-first) collapses that down to
    // one row per real patient before pagination is applied, so it can't
    // reappear on another page either.
    const dedupedPipeline = [
      { $match: filter },
      { $sort: { createdAt: -1 } },
      { $group: { _id: '$patient', doc: { $first: '$$ROOT' } } },
      { $replaceRoot: { newRoot: '$doc' } },
      { $sort: { createdAt: -1 } },
    ];

    const [countResult, requests] = await Promise.all([
      DietPlanRequest.aggregate([...dedupedPipeline, { $count: 'total' }]),
      DietPlanRequest.aggregate([
        ...dedupedPipeline,
        { $skip: skip },
        { $limit: limitNum },
        {
          $lookup: {
            from: 'users',
            localField: 'patient',
            foreignField: '_id',
            as: 'patientDoc',
          },
        },
        { $unwind: { path: '$patientDoc', preserveNullAndEmptyArrays: true } },
        {
          // Reshapes back into the same `request.patient.*` field layout
          // the .populate().select() call below used to produce, so the
          // mapping logic further down needs no changes.
          $project: {
            status: 1,
            membershipPlan: 1,
            plansCount: 1,
            hasActivePlan: 1,
            latestPaymentStatus: 1,
            currentWeight: 1,
            totalKgLost: 1,
            bmiFrom: 1,
            bmiTo: 1,
            completedAt: 1,
            createdAt: 1,
            patient: {
              _id: '$patientDoc._id',
              profile: {
                fullName: '$patientDoc.profile.fullName',
                gender: '$patientDoc.profile.gender',
                dateOfBirth: '$patientDoc.profile.dateOfBirth',
                imageUrl: '$patientDoc.profile.imageUrl',
              },
              healthProfile: {
                weight: '$patientDoc.healthProfile.weight',
                height: '$patientDoc.healthProfile.height',
                bmi: '$patientDoc.healthProfile.bmi',
                activityLevel: '$patientDoc.healthProfile.activityLevel',
                primaryGoal: '$patientDoc.healthProfile.primaryGoal',
              },
              isActive: '$patientDoc.isActive',
              status: {
                firstConsultationId: '$patientDoc.status.firstConsultationId',
                patientConsented: '$patientDoc.status.patientConsented',
              },
            },
          },
        },
      ]),
    ]);
    const total = countResult[0]?.total ?? 0;

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
          bmr,
          tdee,
          primaryGoal: healthProfile.primaryGoal || null,
          activityLevel: healthProfile.activityLevel || null,
          requestId: request._id.toString(),
          isActive: patient.isActive !== false,
          status: request.status || 'Unpaid',
          membershipPlan: request.membershipPlan || null,
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
        hasFirstConsultation: Boolean(patient.status?.firstConsultationId),
        patientConsented: patient.status?.patientConsented === true,
      });
      const { label: statusLabel, category: statusCategory } = mapStatusCodeToLabel(statusCode);

      return {
        patientId,
        fullName: profile.fullName || null,
        avatarUrl: profile.imageUrl || null,
        weight,
        bmi,
        bmr,
        tdee,
        statusCode,
        statusLabel,
        statusCategory,
        membershipPlan: request.membershipPlan || null,
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
          // Simple: sum total surplus/deficit from activation - tdee is
          // already computed above with the patient's real age/gender via
          // calcBmr/calcTdee, no need to re-derive it here.
          const tdeeEst = patient.tdee || 1800;

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
          status: patient.status,
          membershipPlan: patient.membershipPlan,
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
          // request.gender/dateOfBirth/activityLevel are the frozen
          // snapshot taken at request time - already loaded, no extra
          // populate needed, and accurate (age/gender don't change in a
          // way that matters over a few weeks).
          const age = calcAge(request.dateOfBirth);
          const bmrEst =
            calcBmr({ weight: startWeight, height: heightM ? heightM * 100 : null, age, gender: request.gender }) ||
            1800;
          const tdeeEst = calcTdee(bmrEst, request.activityLevel) || bmrEst * 1.55;
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

    // Pagination (AI_EXECUTION_PLAN.md Phase 5, P5-05) - this endpoint had
    // no limit at all before (every request for the dietician, unbounded).
    // Default limit is generous (100) to minimize behavior change for
    // today's callers, which don't pass page/limit and expect "everything".
    const { page, limit, skip } = parsePagination(req.query, { defaultLimit: 100, maxLimit: 200 });
    const total = await DietPlanRequest.countDocuments(filter);

    const requests = await DietPlanRequest.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('patient', 'profile.fullName profile.profileImage healthProfile.primaryGoal');

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
        membershipPlan: request.membershipPlan || null,
      };
    });

    return res.status(200).json({
      success: true,
      data,
      pagination: buildPaginationMeta({ page, limit, total, resultCount: data.length }),
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
 * Shared AI-generation pipeline: recipe-pool filtering, prompt-injection
 * safety check, the AI call scoped to weekNumbers, deterministic validation,
 * risk-flagging, and merging the result into dietPlan.generatedPlan. Used by
 * both the initial createAndGenerateDietPlan (weekNumbers derived from
 * membership tier) and generateWeekForExistingPlan (a later tier-gated
 * regeneration of specific weeks) so the two never drift apart.
 *
 * dietPlan must already be saved with patientId/firstConsultation populated.
 * Mutates and saves dietPlan. Returns { ok: true, validationWarnings,
 * riskFlags } or { ok: false, status, message } (e.g. a safety-check block)
 * for the caller to turn into an HTTP response.
 */
exports.runDietPlanGeneration = runDietPlanGeneration;

async function runDietPlanGeneration({ dietPlan, dieticianId, weekNumbers }) {
  const patientId = dietPlan.patientId?._id?.toString() || dietPlan.patientId?.toString();
  const firstConsultationId =
    dietPlan.firstConsultation?._id?.toString() || dietPlan.firstConsultation?.toString();

  const customAnswers = dietPlan.firstConsultation?.customAnswers || [];
  const getAnswer = (fieldId) => getConsultationAnswer(customAnswers, fieldId);

  const foodsToAvoidText = getAnswer(SAFETY_FIELD_IDS.FOODS_TO_AVOID) || '';
  const finalNotesConcerns = getAnswer(SAFETY_FIELD_IDS.FINAL_NOTES_CONCERNS) || '';
  const freeTextForSafetyCheck = [foodsToAvoidText, finalNotesConcerns].filter(Boolean).join('\n');
  if (freeTextForSafetyCheck) {
    const safety = await checkTextSafety(freeTextForSafetyCheck);
    if (!safety.safe) {
      return {
        ok: false,
        status: 422,
        message:
          "This patient's consultation notes couldn't be processed for AI generation — please review and rephrase them.",
      };
    }
  }

  const eatingStyleValue = getAnswer(SAFETY_FIELD_IDS.EATING_STYLE);
  const eatingStyleFlag = mapEatingStyleToDietFlag(eatingStyleValue ? [eatingStyleValue] : []);

  // "Non-Vegetarian" doesn't mean every meal must be non-veg - real usage
  // here is a mixed week (see dayGroups.js's NON_VEG_ALLOWED_DAY_GROUPS):
  // non-veg dishes are only used on the Monday/Wednesday day-groups
  // (Mon+Fri, Wed+Sun), Tuesday/Thursday (Tue+Sat, Thu) stay vegetarian.
  // So unlike every other eating style, 'nonVegetarian' must NOT hard-filter
  // the candidate pool down to only-nonVegetarian recipes - that would
  // exclude every vegetarian recipe outright (and this kind of library
  // typically has far more vegetarian recipes than non-veg ones across
  // Morning Drink/Breakfast/Brunch/Evening Snack/Night Drink, which stay
  // vegetarian for every patient regardless of eating style anyway). The
  // full pool is kept instead, and the day-group split is enforced via the
  // prompt + validateDietPlan's restrictNonVegToDayGroups check below.
  const isNonVegPatient = eatingStyleFlag === 'nonVegetarian';
  const recipeFilter = { dieticianId };
  if (eatingStyleFlag && !isNonVegPatient) {
    recipeFilter[`dietaryHabits.${eatingStyleFlag}`] = true;
  }

  const candidateRecipes = await Recipe.find(recipeFilter)
    .select('name servingTime dietaryHabits freeFrom nutrition ingredients servingSize components tags category _id')
    .lean();

  const allergyOptions = getAnswer(SAFETY_FIELD_IDS.ALLERGIES) || [];
  const allergyOtherInfo = getAnswer(SAFETY_FIELD_IDS.ALLERGIES_OTHER) || '';

  const excludedForAllergens = [];
  const recipes = candidateRecipes.filter((r) => {
    const conflicts = findAllergenConflicts({
      ingredients: r.ingredients,
      allergyOptions,
      allergyOtherInfo,
      foodsToAvoidText,
    });
    if (conflicts.length > 0) {
      excludedForAllergens.push({ recipeId: r._id.toString(), name: r.name, conflicts });
      return false;
    }
    return true;
  });

  // Supplements already have a dedicated, working manual-selection UX (the
  // Supplements pseudo-slot, see dietPlanOptions.js) - excluded from the AI
  // pool entirely rather than trusting the model to recognize them (the
  // recipePool sent to the prompt doesn't carry `category` at all, so the
  // old prompt instruction asking it to identify "category Supplements"
  // was unenforceable) and to consistently repeat the same recipeId across
  // all 4 day-groups. The dietician adds supplements manually after
  // generation, same as always.
  const recipesForAIPool = recipes.filter((r) => r.category !== 'Supplements');

  const recipeToPromptShape = (r) => ({
    id: r._id.toString(),
    name: r.name,
    servingTime: r.servingTime,
    calories: r.nutrition?.calories || null,
    protein: r.nutrition?.protein || null,
    carbs: r.nutrition?.carbs || null,
    fats: r.nutrition?.fats || null,
    dietaryHabits: r.dietaryHabits || {},
    freeFrom: r.freeFrom || {},
    // Lets the AI identify accompaniments (side/salad) and their portions
    // so it can compose a main + sides combo for Lunch/Dinner, instead of
    // picking exactly one recipe per slot - see buildPrompt's combo rule.
    tags: r.tags || [],
    // The dish's real, independently-adjustable components (see
    // models/Recipe.js's `components`) - e.g. Idli/Sambar/Chutney in
    // nos/bowl/tbsp, not one forced gram total. Falls back to a
    // synthesized single component from the legacy servingSize for a
    // recipe not yet migrated (scripts/migrate-recipe-components.js), so
    // this is never empty/null for a real recipe.
    components: Array.isArray(r.components) && r.components.length > 0
      ? r.components
      : [{ label: r.name, quantity: r.servingSize?.quantity || 1, unit: r.servingSize?.unit || 'g' }],
  });

  // Flat pool: used by validateDietPlan's closed-world check and the
  // inputHash - unchanged shape from before, just built from
  // recipesForAIPool (Supplements excluded).
  const recipePool = recipesForAIPool.map(recipeToPromptShape);

  // Per-slot pool for the prompt - reuses dietPlanOptions.js's exact
  // side/salad/Supplements-aware bucketing (Supplements bucket will
  // naturally be empty/absent since recipesForAIPool already excludes
  // every Supplements-category doc), so a Dinner-only recipe is never even
  // shown to the model under any other slot's heading.
  const recipesByServingTimeDocs = buildRecipesByServingTimeMap(recipesForAIPool);
  const recipePoolByServingTime = {};
  REQUIRED_SERVING_TIMES.forEach((slot) => {
    recipePoolByServingTime[slot] = (recipesByServingTimeDocs[slot] || []).map(recipeToPromptShape);
  });

  const inputHash = crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        patientId,
        firstConsultationId,
        calorieStrategy: dietPlan.calorieStrategy,
        macroStrategy: dietPlan.macroStrategy,
        recipeIds: recipePool.map((r) => r.id).sort(),
        weekNumbers,
      })
    )
    .digest('hex');

  // Outer, content-aware retry loop: up to 3 total attempts (1 initial + 2
  // corrective retries). Distinct from generateDietPlanWithAI's own inner
  // retry loop (2 attempts, transport/refusal errors only, same prompt) -
  // this loop inspects validateDietPlan's findings and rewrites the prompt
  // with a corrective note between attempts, so the model gets a real
  // chance to fix specifically what it got wrong last time before we ever
  // consider saving/showing a broken plan.
  const MAX_GENERATION_ATTEMPTS = 3;
  const weightTrend = await resolveWeightTrend(patientId);

  const generationStartedAt = Date.now();
  let generatedText = '';
  let parsedGeneratedPlan = null;
  let validationResult = null;
  let correctiveNote = '';
  let attemptsUsed = 0;
  let repairChangesMade = [];

  for (let attempt = 1; attempt <= MAX_GENERATION_ATTEMPTS; attempt++) {
    attemptsUsed = attempt;
    generatedText = await generateDietPlanWithAI({
      patient: dietPlan.patientId,
      firstConsultation: dietPlan.firstConsultation,
      calorieStrategy: dietPlan.calorieStrategy,
      macroStrategy: dietPlan.macroStrategy,
      recipesByServingTime: recipePoolByServingTime,
      weekNumbers,
      correctiveNote,
      restrictNonVegToDayGroups: isNonVegPatient,
    });

    try {
      parsedGeneratedPlan = JSON.parse(generatedText);
    } catch (_) {
      parsedGeneratedPlan = null; // validateDietPlan treats this as zero weeks
    }

    validationResult = validateDietPlan({
      parsedPlan: parsedGeneratedPlan,
      recipePool,
      calorieStrategy: dietPlan.calorieStrategy,
      weightTrend,
      restrictNonVegToDayGroups: isNonVegPatient,
    });

    // Deterministic repair before spending another AI call: a model that
    // broke the "only pick from this slot's list" rule once often breaks
    // it again differently on retry rather than reliably self-correcting -
    // see dietPlanRepair.js's header comment. Attempted whenever AT LEAST
    // ONE severe issue is a mechanically-fixable type - repair only ever
    // touches entries tied to those specific issues (drop + backfill),
    // never anything else, so it's monotonically at least as structurally
    // sound as the original; the repaired result is always adopted (not
    // only when it comes out fully clean) so a plan that also has a
    // genuine calorie-budget miss still gets its structural problems fixed
    // now, leaving only the calorie issue for the AI's own corrective
    // retry (or, on the final attempt, to save as a documented warning
    // rather than rejecting an otherwise-sound plan outright).
    if (
      validationResult.hasSevereIssues &&
      parsedGeneratedPlan &&
      validationResult.severeIssues.some((issue) => REPAIRABLE_SEVERE_ISSUE_TYPES.has(issue.type))
    ) {
      const { repairedPlan, changesMade } = repairStructuralIssues({
        parsedPlan: parsedGeneratedPlan,
        recipePool,
        recipePoolByServingTime,
        restrictNonVegToDayGroups: isNonVegPatient,
      });
      const revalidation = validateDietPlan({
        parsedPlan: repairedPlan,
        recipePool,
        calorieStrategy: dietPlan.calorieStrategy,
        weightTrend,
        restrictNonVegToDayGroups: isNonVegPatient,
      });
      parsedGeneratedPlan = repairedPlan;
      validationResult = revalidation;
      repairChangesMade = changesMade;
    }

    if (!validationResult.hasSevereIssues) break;
    if (attempt === MAX_GENERATION_ATTEMPTS) break;
    correctiveNote = formatSevereIssuesForPrompt(validationResult.severeIssues);
  }
  const generationLatencyMs = Date.now() - generationStartedAt;

  if (validationResult.hasSevereIssues) {
    try {
      await GenerationLog.create({
        kind: 'dietPlan',
        dieticianId,
        refId: dietPlan._id,
        model: config.openai.dietPlanModel,
        inputHash,
        latencyMs: generationLatencyMs,
        validatorWarnings: validationResult.warnings,
        succeeded: false,
      });
    } catch (logError) {
      console.error('Failed to write GenerationLog entry:', logError.message);
    }

    return {
      ok: false,
      status: 502,
      message: `AI diet-plan generation produced severe, unresolvable issues after ${attemptsUsed} attempt(s) (e.g. wrong-meal-slot assignments or calories far outside the target budget). No plan was saved - please try regenerating, or contact support if this persists. Details: ${validationResult.severeIssues
        .slice(0, 5)
        .map((i) => i.message)
        .join(' | ')}`,
    };
  }

  const newValidationWarnings = validationResult.warnings;
  if (repairChangesMade.length > 0) {
    newValidationWarnings.push(
      `${repairChangesMade.length} entry/entries were automatically corrected after generation (invalid slot placements removed/backfilled): ${repairChangesMade.join(' ')}`
    );
  }
  if (excludedForAllergens.length > 0) {
    newValidationWarnings.push(
      `${excludedForAllergens.length} recipe(s) were excluded from selection due to a potential allergen/foods-to-avoid conflict: ${excludedForAllergens
        .map((e) => e.name)
        .join(', ')}.`
    );
  }

  const newRiskFlags = [];
  const patientProfile = dietPlan.patientId?.profile || {};
  const patientHealth = dietPlan.patientId?.healthProfile || {};
  const patientAge = calcAge(patientProfile.dateOfBirth);
  if (typeof patientAge === 'number' && patientAge < 18) {
    newRiskFlags.push('isMinor');
  }
  const requestedCalorieBudget = dietPlan.calorieStrategy?.calorieBudget;
  const requestedProteinPercent = dietPlan.macroStrategy?.proteinPercent;
  const patientWeight = patientHealth.weight;
  if (
    typeof requestedCalorieBudget === 'number' &&
    typeof requestedProteinPercent === 'number' &&
    typeof patientWeight === 'number' &&
    patientWeight > 0
  ) {
    const requestedProteinG = (requestedCalorieBudget * (requestedProteinPercent / 100)) / 4;
    const proteinTarget = calcProteinTargetG({
      weightKg: patientWeight,
      isCaloricDeficit: (dietPlan.calorieStrategy?.calorieDeficit || 0) > 0,
    });
    if (proteinTarget && requestedProteinG > proteinTarget.maxG) {
      newRiskFlags.push('highProteinForWeight');
    }
  }
  if (newRiskFlags.includes('isMinor') && newRiskFlags.includes('highProteinForWeight')) {
    newRiskFlags.push('minorOnHighProteinPlan');
  }

  // Merge the newly generated week(s) into any existing generatedPlan
  // instead of overwriting it wholesale, so a later regeneration of weeks
  // 3-4 doesn't wipe out weeks 1-2 generated earlier.
  let existingWeeks = [];
  if (dietPlan.generatedPlan) {
    try {
      const existingParsed = JSON.parse(dietPlan.generatedPlan);
      existingWeeks = Array.isArray(existingParsed?.weeks) ? existingParsed.weeks : [];
    } catch (_) {
      existingWeeks = [];
    }
  }
  const newWeeks = Array.isArray(parsedGeneratedPlan?.weeks) ? parsedGeneratedPlan.weeks : [];
  const newWeekNumbers = new Set(newWeeks.map((w) => w.week));
  const mergedWeeks = [
    ...existingWeeks.filter((w) => !newWeekNumbers.has(w.week)),
    ...newWeeks,
  ].sort((a, b) => a.week - b.week);

  dietPlan.generatedPlan = JSON.stringify({ weeks: mergedWeeks });
  dietPlan.generatedAt = new Date();
  // Warnings/risk flags are already labeled per-week by validateDietPlan, so
  // concatenating across generation runs (rather than replacing) keeps the
  // full history visible instead of losing week 1's warnings when weeks 3-4
  // are generated later. Dedupe defensively in case the same week is
  // regenerated and produces an identical warning twice.
  dietPlan.validationWarnings = [...new Set([...(dietPlan.validationWarnings || []), ...newValidationWarnings])];
  dietPlan.riskFlags = [...new Set([...(dietPlan.riskFlags || []), ...newRiskFlags])];
  dietPlan.modelSnapshot = config.openai.dietPlanModel;
  dietPlan.inputHash = inputHash;
  await dietPlan.save();

  try {
    await GenerationLog.create({
      kind: 'dietPlan',
      dieticianId,
      refId: dietPlan._id,
      model: config.openai.dietPlanModel,
      inputHash,
      latencyMs: generationLatencyMs,
      validatorWarnings: newValidationWarnings,
      succeeded: true,
    });
  } catch (logError) {
    console.error('Failed to write GenerationLog entry:', logError.message);
  }

  return { ok: true, validationWarnings: newValidationWarnings, riskFlags: newRiskFlags };
}

/**
 * @desc    Create a diet plan and immediately generate AI content
 * @route   POST /api/dietician/patients/:patientId/diet-plans/generate
 * @access  Private (Dietician)
 */
exports.createAndGenerateDietPlan = async (req, res, next) => {
  try {
    const { patientId } = req.params;
    const dieticianId = req.user._id;
    const { requestId, firstConsultationId, calorieStrategy, macroStrategy, startDate, currentWeight } =
      req.body;

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

    const tier = getMembershipTier(dietPlanRequest.membershipPlan);
    const weekNumbers = TIER_INITIAL_WEEKS[tier];
    if (!weekNumbers) {
      return res.status(400).json({
        success: false,
        message:
          'This patient has no recognized membership plan selected yet - a plan must be chosen before a diet plan can be generated.',
      });
    }

    // Always resolved (defaults to now), unlike before, since weekSchedule
    // needs an anchor date regardless of whether the dietician picked one.
    const rawParsedStartDate = startDate ? new Date(startDate) : new Date();
    const parsedStartDate = Number.isNaN(rawParsedStartDate.getTime()) ? new Date() : rawParsedStartDate;

    // This endpoint doubles as "start a new renewal cycle" whenever it's
    // called for a patient who already has plan history (no separate
    // renewal-generation endpoint - see docs/cron-setup.md and the renewal
    // flow in controllers/patient/dietPlanRequestController.js::startRenewal
    // for how the request gets reset to Unpaid first). cycleNumber drives a
    // *display-only* week offset (Week 5-8 for cycle 2, etc.) - the internal
    // 1-4 week numbering, generation, and finalize logic below are
    // completely unchanged for a renewal vs. a first-time plan.
    const previousPlan = await DietPlan.findOne({ patientId, request: resolvedRequestId })
      .sort({ cycleNumber: -1 })
      .select('cycleNumber status')
      .lean();
    const cycleNumber = previousPlan ? (previousPlan.cycleNumber || 1) + 1 : 1;
    if (previousPlan && previousPlan.status === 'Active') {
      await DietPlan.updateMany(
        { patientId, request: resolvedRequestId, status: 'Active' },
        { $set: { status: 'Completed' } }
      );
    }

    const dietPlan = new DietPlan({
      patientId,
      dieticianId,
      request: resolvedRequestId,
      firstConsultation: firstConsultationId,
      calorieStrategy,
      macroStrategy,
      status: 'Draft',
      startDate: parsedStartDate,
      cycleNumber,
      weekSchedule: buildWeekSchedule(parsedStartDate),
    });

    await dietPlan.save();

    // Log the weight that informed this plan's calorie strategy - keeps
    // healthProfile.weight in sync the same way a patient's own log does,
    // but with a real Progress entry instead of a blind overwrite.
    const parsedWeight = typeof currentWeight === 'number' ? currentWeight : Number(currentWeight);
    if (typeof parsedWeight === 'number' && !Number.isNaN(parsedWeight) && parsedWeight > 0) {
      await logWeight(patientId, parsedWeight, {
        dieticianId,
        source: 'dietician',
        dietPlanId: dietPlan._id,
        week: 1,
      });
    }

    await dietPlan.populate([
      { path: 'patientId', select: 'profile healthProfile' },
      { path: 'firstConsultation' },
    ]);

    // dietPlan.status is already 'Draft' from construction above -
    // runDietPlanGeneration saves generatedPlan/validationWarnings/etc.
    // without touching status, which is what a later regeneration (that
    // must not downgrade an already-Finalized/Active plan) needs too.
    const generationResult = await runDietPlanGeneration({ dietPlan, dieticianId, weekNumbers });
    if (!generationResult.ok) {
      return res.status(generationResult.status).json({ success: false, message: generationResult.message });
    }

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
        riskFlags: dietPlan.riskFlags,
        validationWarnings: dietPlan.validationWarnings,
        cycleNumber: dietPlan.cycleNumber,
        weekSchedule: dietPlan.weekSchedule,
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Generate (or regenerate) specific week(s) of an existing diet
 *          plan - the dietician-initiated cadence for Golden (weeks 3-4,
 *          once week 2 is finalized) and Platinum (one week at a time, each
 *          gated on the immediately-prior week being finalized) tiers.
 * @route   POST /api/dietician/patients/:patientId/diet-plans/:dietPlanId/generate-week
 * @access  Private (Dietician)
 */
exports.generateWeekForExistingPlan = async (req, res, next) => {
  try {
    const { patientId, dietPlanId } = req.params;
    const dieticianId = req.user._id;
    const { weekNumbers, currentWeight, calorieStrategy, macroStrategy, startDate } = req.body;

    if (
      !mongoose.Types.ObjectId.isValid(patientId) ||
      !mongoose.Types.ObjectId.isValid(dietPlanId)
    ) {
      return res.status(400).json({ success: false, message: 'Invalid patient or diet plan id' });
    }

    if (
      !Array.isArray(weekNumbers) ||
      weekNumbers.length === 0 ||
      weekNumbers.some((w) => !Number.isInteger(w) || w < 1 || w > 4)
    ) {
      return res.status(400).json({
        success: false,
        message: 'weekNumbers must be a non-empty array of integers between 1 and 4',
      });
    }
    const sortedWeekNumbers = [...weekNumbers].sort((a, b) => a - b);

    if (!calorieStrategy || !macroStrategy) {
      return res.status(400).json({
        success: false,
        message: 'calorieStrategy and macroStrategy are required',
      });
    }

    const dietPlan = await DietPlan.findOne({ _id: dietPlanId, patientId, dieticianId }).populate([
      { path: 'request' },
      { path: 'patientId', select: 'profile healthProfile' },
      { path: 'firstConsultation' },
    ]);

    if (!dietPlan) {
      return res.status(404).json({ success: false, message: 'Diet plan not found for this patient' });
    }

    const tier = getMembershipTier(dietPlan.request?.membershipPlan);

    let existingWeekNumbers = [];
    if (dietPlan.generatedPlan) {
      try {
        const parsed = JSON.parse(dietPlan.generatedPlan);
        existingWeekNumbers = Array.isArray(parsed?.weeks) ? parsed.weeks.map((w) => w.week) : [];
      } catch (_) {
        existingWeekNumbers = [];
      }
    }
    const finalizedWeekNumbers = Array.isArray(dietPlan.finalizedPlan?.weeks)
      ? dietPlan.finalizedPlan.weeks.map((w) => w.week)
      : [];

    // The week being superseded - week 2 for Golden's [3,4], week (N-1) for
    // Platinum's single week N - is always sortedWeekNumbers[0] - 1 in both
    // cases, so one lookup covers both tiers.
    const priorWeekNumber = sortedWeekNumbers[0] - 1;
    const currentWeekSchedule = Array.isArray(dietPlan.weekSchedule)
      ? dietPlan.weekSchedule.find((w) => w.week === priorWeekNumber)
      : null;

    const validation = validateRegenerateRequest({
      tier,
      weekNumbers: sortedWeekNumbers,
      existingWeekNumbers,
      finalizedWeekNumbers,
      currentWeekSchedule,
      now: new Date(),
    });
    if (!validation.ok) {
      return res.status(403).json({ success: false, message: validation.message });
    }

    // The newly submitted strategy becomes "current" - weeksSummary (written
    // at finalize time, per-week) is what preserves each week's actual
    // historical breakdown even as this top-level field moves forward.
    dietPlan.calorieStrategy = calorieStrategy;
    dietPlan.macroStrategy = macroStrategy;

    // Whenever the dietician picks a date for this generation, the week(s)
    // being generated span 7 days per week from there, and every later week
    // cascades to follow - keeps the whole plan's schedule contiguous
    // instead of leaving a gap/overlap after the ones actually being
    // regenerated (see cascadeWeekScheduleFrom's doc comment). Falls back
    // to leaving weekSchedule untouched when no date is supplied (e.g. a
    // plain content regenerate with no date change). A past date is
    // silently floored to today rather than rejected outright - this
    // endpoint also does AI content generation, weight logging, etc., so
    // failing the whole request over a stale date field would be
    // disproportionate (the dedicated updateWeekScheduleDate endpoint,
    // which does nothing else, rejects outright instead).
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    let parsedStartDate = startDate ? new Date(startDate) : null;
    if (parsedStartDate && !Number.isNaN(parsedStartDate.getTime()) && parsedStartDate < today) {
      parsedStartDate = today;
    }
    if (parsedStartDate && !Number.isNaN(parsedStartDate.getTime())) {
      dietPlan.weekSchedule = cascadeWeekScheduleFrom(
        dietPlan.weekSchedule,
        sortedWeekNumbers[0],
        parsedStartDate
      );
    }

    const parsedWeight = typeof currentWeight === 'number' ? currentWeight : Number(currentWeight);
    if (typeof parsedWeight === 'number' && !Number.isNaN(parsedWeight) && parsedWeight > 0) {
      await logWeight(patientId, parsedWeight, {
        dieticianId,
        source: 'dietician',
        dietPlanId: dietPlan._id,
        week: sortedWeekNumbers[0],
      });
    }

    const generationResult = await runDietPlanGeneration({
      dietPlan,
      dieticianId,
      weekNumbers: sortedWeekNumbers,
    });
    if (!generationResult.ok) {
      return res.status(generationResult.status).json({ success: false, message: generationResult.message });
    }

    return res.status(200).json({
      success: true,
      data: {
        dietPlanId: dietPlan._id,
        status: dietPlan.status,
        generatedPlan: dietPlan.generatedPlan,
        riskFlags: dietPlan.riskFlags,
        validationWarnings: dietPlan.validationWarnings,
        weekSchedule: dietPlan.weekSchedule,
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Move a single week's date (and cascade every later week to follow
 *          it, see cascadeWeekScheduleFrom) - a lightweight alternative to
 *          generateWeekForExistingPlan for when the dietician only wants to
 *          reschedule a week, not touch its content/strategy. Works for any
 *          week regardless of whether it's been generated yet - weekSchedule
 *          always has placeholder entries for all 4 weeks up front (see
 *          createAndGenerateDietPlan). Preponing is allowed, but never to
 *          before today - the dietician can't reschedule into the past.
 * @route   PATCH /api/dietician/patients/:patientId/diet-plans/:dietPlanId/weeks/:week/schedule
 * @access  Private (Dietician)
 */
exports.updateWeekScheduleDate = async (req, res, next) => {
  try {
    const { patientId, dietPlanId, week } = req.params;
    const dieticianId = req.user._id;
    const { startDate } = req.body || {};

    if (
      !mongoose.Types.ObjectId.isValid(patientId) ||
      !mongoose.Types.ObjectId.isValid(dietPlanId)
    ) {
      return res.status(400).json({ success: false, message: 'Invalid patient or diet plan id' });
    }

    const weekNumber = parseInt(week, 10);
    if (!Number.isInteger(weekNumber) || weekNumber < 1 || weekNumber > 4) {
      return res.status(400).json({ success: false, message: 'week must be an integer between 1 and 4' });
    }

    const parsedStartDate = startDate ? new Date(startDate) : null;
    if (!parsedStartDate || Number.isNaN(parsedStartDate.getTime())) {
      return res.status(400).json({ success: false, message: 'startDate is required and must be a valid date' });
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    if (parsedStartDate < today) {
      return res.status(400).json({
        success: false,
        message: 'startDate cannot be earlier than today',
      });
    }

    const dietPlan = await DietPlan.findOne({ _id: dietPlanId, patientId, dieticianId });
    if (!dietPlan) {
      return res.status(404).json({ success: false, message: 'Diet plan not found for this patient' });
    }

    dietPlan.weekSchedule = cascadeWeekScheduleFrom(dietPlan.weekSchedule, weekNumber, parsedStartDate);
    await dietPlan.save();

    return res.status(200).json({
      success: true,
      data: { dietPlanId: dietPlan._id, weekSchedule: dietPlan.weekSchedule },
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
      ).lean()
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
        riskFlags: dietPlan.riskFlags || [],
        validationWarnings: dietPlan.validationWarnings || [],
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

    const [recipeDocs, weightTrend] = await Promise.all([
      fetchRecipePoolForOptions({ Recipe, dieticianId }),
      resolveWeightTrend(patientId),
    ]);

    const dayGroups = buildDayGroupsOptions({
      recipeDocs,
      dailyMeals: currentWeekEntry.dailyMeals || [],
      nextWeekDailyMeals: nextWeekEntry?.dailyMeals || [],
      currentWeekNumber: parsedWeekNumber,
    });

    return res.status(200).json({
      success: true,
      data: {
        dietPlanId: dietPlan._id,
        week: parsedWeekNumber,
        summary,
        dayGroups,
        weightTrend,
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    View a not-yet-finalized (AI-generated Draft) week's recipe
 *          options - the same shape as getFinalizedWeekDetails, but reads
 *          `generatedPlan` and works for any diet plan status, so the
 *          dietician can review/select from the full options pool (not
 *          just the AI's single pick per slot) before finalizing.
 * @route   GET /api/dietician/patients/:patientId/diet-plans/:dietPlanId/weeks/:weekNumber/draft-options
 * @access  Private (Dietician)
 */
exports.getDraftWeekOptions = async (req, res, next) => {
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

    const dietPlan = await DietPlan.findOne({ _id: dietPlanId, patientId, dieticianId }).lean();

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

    const planWeeks = Array.isArray(parsedPlan.weeks) ? parsedPlan.weeks : [];
    const finalizedWeeks = Array.isArray(dietPlan.finalizedPlan?.weeks) ? dietPlan.finalizedPlan.weeks : [];

    // Prefer the dietician's actual finalized selections (real servings,
    // and possibly more recipes than the AI's original picks - e.g. an
    // additionally-selected side/salad) over the AI's raw draft once a
    // week has been finalized. generatedPlan is never updated at finalize
    // time (see finalizeWeekPlan below), so re-opening an already-
    // finalized week via "Update Diet Plan" must read from finalizedPlan
    // or it silently resets every serving/selection back to the AI's
    // original defaults.
    const findWeekEntry = (weekNum) =>
      finalizedWeeks.find((entry) => entry?.week === weekNum) ||
      planWeeks.find((entry) => entry?.week === weekNum);

    const currentWeekEntry = findWeekEntry(parsedWeekNumber);

    if (!currentWeekEntry) {
      return res.status(404).json({
        success: false,
        message: 'This week has not been generated yet',
      });
    }

    const nextWeekEntry = parsedWeekNumber < 4 ? findWeekEntry(parsedWeekNumber + 1) : null;

    // Whether currentWeekEntry came from finalizedPlan (real, dietician-set
    // servings) vs generatedPlan (the AI's draft, which has no `servings`
    // field at all - see dietPlanJsonSchema.js). The dietician app needs
    // this to know whether a `servings` of exactly 1 is a genuine explicit
    // choice or just the "not yet set" placeholder default - see
    // isUnexplicitDefault in patients_controller.dart.
    const isFinalized = finalizedWeeks.some((entry) => entry?.week === parsedWeekNumber);

    const [recipeDocs, weightTrend] = await Promise.all([
      fetchRecipePoolForOptions({ Recipe, dieticianId }),
      resolveWeightTrend(patientId),
    ]);

    const dayGroups = buildDayGroupsOptions({
      recipeDocs,
      dailyMeals: currentWeekEntry.dailyMeals || [],
      nextWeekDailyMeals: nextWeekEntry?.dailyMeals || [],
      currentWeekNumber: parsedWeekNumber,
    });

    // Summary = the AI's actually-selected recipes' nutrition totals across
    // every day-group's picks for this week (an "all varieties combined"
    // figure, not one representative day) - superseded by the dietician
    // app's own live per-day-group totals (calculateTotalsForWeek), kept
    // here mainly for response-shape compatibility.
    const selectedRecipeIds = [
      ...new Set(
        (currentWeekEntry.dailyMeals || [])
          .filter((m) => m?.recipeId)
          .map((m) => m.recipeId.toString())
      ),
    ];
    const nutritionById = new Map(recipeDocs.map((r) => [r._id.toString(), r.nutrition || {}]));
    const summary = selectedRecipeIds.reduce(
      (acc, id) => {
        const n = nutritionById.get(id) || {};
        acc.totalCalories += n.calories || 0;
        acc.fatGrams += n.fats || 0;
        acc.carbGrams += n.carbs || 0;
        acc.proteinGrams += n.protein || 0;
        return acc;
      },
      { totalCalories: 0, fatPercent: 0, fatGrams: 0, carbPercent: 0, carbGrams: 0, proteinPercent: 0, proteinGrams: 0 }
    );

    return res.status(200).json({
      success: true,
      data: {
        dietPlanId: dietPlan._id,
        week: parsedWeekNumber,
        summary,
        dayGroups,
        weightTrend,
        isFinalized,
        riskFlags: dietPlan.riskFlags || [],
        validationWarnings: dietPlan.validationWarnings || [],
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

    // Keep every selected recipe for a slot (not just one) - a Lunch/Dinner
    // slot legitimately holds a main dish plus separately-selected sides/
    // salad, each its own dailyMeals entry sharing the same dayGroup+
    // servingTime. De-dupe exact {dayGroup, servingTime, recipeId} repeats
    // defensively - the same recipe/slot legitimately repeats across
    // *different* day-groups (e.g. Chapati at Monday-group's Lunch AND
    // Tuesday-group's Lunch), so dayGroup must be part of the key.
    const seenMealKeys = new Set();
    const normalizedMeals = cleanedSelectedMeals.filter((meal) => {
      if (!REQUIRED_SERVING_TIMES.includes(meal.servingTime)) return false;
      const key = `${meal.dayGroup}|${meal.servingTime}|${meal.recipeId}`;
      if (seenMealKeys.has(key)) return false;
      seenMealKeys.add(key);
      return true;
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

    // Computed server-side from each selected recipe's *current* nutrition
    // data (fetched by id), not trusted from whatever the client submitted -
    // see computeWeekSummary's doc comment. This is what makes the
    // dietician's live "Total Budget" preview, the stored weeksSummary, and
    // the patient app's reading of it impossible to drift apart, and keeps
    // it in sync if a recipe's nutrition is corrected later.
    const summaryRecipeIds = [
      ...new Set(normalizedMeals.map((m) => m.recipeId).filter(Boolean)),
    ];
    const summaryRecipeDocs = summaryRecipeIds.length
      ? await Recipe.find({ _id: { $in: summaryRecipeIds } })
          .select('nutrition servingSize secondaryComponent category servingTime name tags')
          .lean()
      : [];
    const computedSummary = computeWeekSummary(normalizedMeals, summaryRecipeDocs);

    // Re-verify the dietician's actual submitted selections - generation-
    // time warnings go stale the instant a recipe is added/swapped, so this
    // is the real gate: a wrong-slot recipe or a calorie total far outside
    // the target budget blocks finalize outright instead of just warning.
    const recipeDocsById = new Map(summaryRecipeDocs.map((r) => [r._id.toString(), r]));
    const blockingIssues = computeFinalizeBlockingIssues({
      normalizedMeals,
      recipeDocsById,
      calorieBudget: dietPlan.calorieStrategy?.calorieBudget,
      computedSummary,
    });

    if (blockingIssues.unknownRecipeIds.length > 0) {
      return res.status(400).json({
        success: false,
        message: `Week ${weekNumber}: ${blockingIssues.unknownRecipeIds.length} selected recipe(s) could not be found - they may have been deleted. Please reselect: ${blockingIssues.unknownRecipeIds.join(', ')}`,
      });
    }
    if (blockingIssues.slotMismatches.length > 0) {
      return res.status(422).json({
        success: false,
        message: `Week ${weekNumber} cannot be finalized: ${blockingIssues.slotMismatches.length} recipe(s) are assigned to the wrong meal slot.`,
        details: blockingIssues.slotMismatches,
      });
    }
    if (blockingIssues.calorieSevere) {
      return res.status(422).json({
        success: false,
        message: `Week ${weekNumber} cannot be finalized: ${blockingIssues.calorieSevere.message} Please adjust portions/selections before finalizing.`,
        details: [blockingIssues.calorieSevere],
      });
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

    const normalizedSummary = {
      week: weekNumber,
      totalCalories: computedSummary.totalCalories,
      fatPercent: 0,
      fatGrams: computedSummary.fatGrams,
      carbPercent: 0,
      carbGrams: computedSummary.carbGrams,
      proteinPercent: 0,
      proteinGrams: computedSummary.proteinGrams,
      fiberGrams: computedSummary.fiberGrams,
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

    // Log the weight used for this week's recalculation (for week 2/3/4) -
    // a real Progress entry instead of a blind healthProfile overwrite, so
    // there's an auditable record of what weight informed which week.
    const currentWeight = Number(req.body?.currentWeight);
    if (currentWeight > 0 && Number.isFinite(currentWeight)) {
      await logWeight(patientId, currentWeight, {
        dieticianId,
        source: 'dietician',
        dietPlanId: dietPlan._id,
        week: weekNumber,
      });
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

    // Clean/dedupe every week's meals first (no DB access needed for this
    // part), so every recipeId referenced across all 4 weeks can be fetched
    // in a single query before computing each week's summary.
    const weeksWithNormalizedMeals = weeks.map((weekEntry) => {
      if (!Array.isArray(weekEntry.dailyMeals)) {
        throw new Error(`Week ${weekEntry.week}: dailyMeals must be an array`);
      }

      const cleanedDailyMeals = cleanSelectedMeals(weekEntry.dailyMeals);

      // Removed validation for missing servingTimes

      // Keep every selected recipe for a slot (not just one) - see the
      // matching fix/comment in finalizeWeekPlan above.
      const seenMealKeys = new Set();
      const normalizedMeals = cleanedDailyMeals.filter((meal) => {
        if (!REQUIRED_SERVING_TIMES.includes(meal.servingTime)) return false;
        const key = `${meal.dayGroup}|${meal.servingTime}|${meal.recipeId}`;
        if (seenMealKeys.has(key)) return false;
        seenMealKeys.add(key);
        return true;
      });

      return { week: weekEntry.week, normalizedMeals };
    });

    const allRecipeIds = [
      ...new Set(
        weeksWithNormalizedMeals
          .flatMap((w) => w.normalizedMeals.map((m) => m.recipeId))
          .filter(Boolean)
      ),
    ];
    const allRecipeDocs = allRecipeIds.length
      ? await Recipe.find({ _id: { $in: allRecipeIds } })
          .select('nutrition servingSize secondaryComponent category servingTime name tags')
          .lean()
      : [];
    const recipeDocsById = new Map(allRecipeDocs.map((r) => [r._id.toString(), r]));

    // Re-verify every week's actual submitted selections before saving
    // anything - see the matching check/rationale in finalizeWeekPlan.
    // Accumulated across all 4 weeks so the dietician sees every problem
    // at once instead of fixing one week, resubmitting, and hitting the
    // next.
    const blockingIssuesByWeek = [];

    weeksWithNormalizedMeals.forEach(({ week, normalizedMeals }) => {
      normalizedWeeks.push({ week, dailyMeals: normalizedMeals });

      // Computed server-side from each recipe's *current* nutrition data,
      // not trusted from the client's submitted summary - see
      // computeWeekSummary's doc comment and the matching fix in
      // finalizeWeekPlan above.
      const computedSummary = computeWeekSummary(normalizedMeals, allRecipeDocs);
      normalizedSummaries.push({
        week,
        totalCalories: computedSummary.totalCalories,
        fatPercent: 0,
        fatGrams: computedSummary.fatGrams,
        carbPercent: 0,
        carbGrams: computedSummary.carbGrams,
        proteinPercent: 0,
        proteinGrams: computedSummary.proteinGrams,
        fiberGrams: computedSummary.fiberGrams,
      });

      const blockingIssues = computeFinalizeBlockingIssues({
        normalizedMeals,
        recipeDocsById,
        calorieBudget: dietPlan.calorieStrategy?.calorieBudget,
        computedSummary,
      });
      if (blockingIssues.hasBlockingIssues) {
        blockingIssuesByWeek.push({ week, ...blockingIssues });
      }
    });

    if (blockingIssuesByWeek.length > 0) {
      return res.status(422).json({
        success: false,
        message: `Cannot finalize: severe issues found in ${blockingIssuesByWeek.length} week(s).`,
        details: blockingIssuesByWeek,
      });
    }

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
      // An approved proof can still leave a balance owed (the dietician
      // chose to activate anyway, trusting the rest is paid later) - that's
      // 'PartiallyPaid', not 'Paid'. Without a proof (e.g. reactivating an
      // already-paid plan), there's nothing to be partial about.
      const amountPending = proofDocument ? proofDocument.amountPending || 0 : 0;
      dietPlan.request.status = amountPending > 0 ? 'PartiallyPaid' : 'Paid';
      dietPlan.request.hasActivePlan = true;
      dietPlan.request.latestPaymentStatus = amountPending > 0 ? 'Pending' : 'Paid';
      if (proofDocument) {
        dietPlan.request.latestPaymentProof = proofDocument._id;
        dietPlan.request.collectedAmount = proofDocument.amountReceived || 0;
      }

      // Set subscription validity (30 days from now)
      const now = new Date();
      const expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
      dietPlan.request.subscriptionStartDate = now;
      dietPlan.request.subscriptionExpiresAt = expiresAt;
      // Fresh expiry window (first activation or a renewal) means any prior
      // "expiring soon" reminder is stale - clear it so the renewal-reminder
      // sweep (controllers/internal/renewalReminderController.js) can notify
      // again for *this* cycle's expiry, 3 days out.
      dietPlan.request.renewalReminderSentAt = null;

      await dietPlan.request.save();
    }

    dietPlan.status = 'Active';
    dietPlan.isPaid = true;
    dietPlan.activationDate = dietPlan.activationDate || new Date();
    await dietPlan.save();

    // Goal Journey Timeline seeding (fire-and-forget - must never fail or
    // delay activation). See utils/seedGoalTimeline.js for the create-vs-
    // extend logic (first activation creates the goal; a later renewal
    // extends its existing timeline instead of re-seeding).
    seedGoalTimeline(dietPlan).catch((err) => {
      console.error('[activateDietPlan] goal timeline seeding failed:', err.message);
    });

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
