// Patient-facing read/write pair for the Exercise Plan feature - mirrors
// dietController.js's getActiveDietPlanForPatient/getTodayMealLogStats/
// submitMealLog shape and conventions closely, scoped down for
// ExercisePlan's simpler (non-week-cycled) schema.

const mongoose = require('mongoose');
const { ExercisePlan, ExerciseLog, Exercise } = require('../../models');
const { resolveDayGroupForDate } = require('../../utils/dayGroups');
const {
  calcCaloriesBurned,
  estimateDurationMinutes,
  resolvePatientWeightKg,
  DEFAULT_FALLBACK_WEIGHT_KG,
} = require('../../utils/exerciseHelpers');

// UTC-based, not local-timezone-based - same fix, same reasoning as
// dietController.js's normalizeDate: dates travel between client/server as
// plain "yyyy-MM-dd" strings, which JS always parses as UTC midnight, so
// local getters here (as this used to use, via setHours) drift the
// stripped-down date by the server's UTC offset whenever it isn't exactly
// 0 - e.g. a day fully logged under CEST could read back as belonging to
// the wrong calendar day.
const normalizeDate = (dateObj) =>
  new Date(Date.UTC(dateObj.getUTCFullYear(), dateObj.getUTCMonth(), dateObj.getUTCDate()));

const getStartOfDay = (d = new Date()) => normalizeDate(d);

const getEndOfDay = (d = new Date()) => new Date(normalizeDate(d).getTime() + 24 * 60 * 60 * 1000 - 1);

/**
 * @route   GET /api/patient/exercise/active
 * @desc    The patient's currently active exercise plan, with each
 *          dailyExercises entry's Exercise doc populated - mirrors
 *          getActiveDietPlanForPatient's shape.
 * @access  Private (Patient)
 */
exports.getActiveExercisePlanForPatient = async (req, res, next) => {
  try {
    const plan = await ExercisePlan.findOne({
      patientId: req.user._id,
      status: 'Active',
    })
      .populate('dailyExercises.exerciseId')
      .lean();

    if (!plan) {
      return res.status(404).json({
        success: false,
        message: 'Active exercise plan not found',
      });
    }

    return res.status(200).json({
      success: true,
      data: plan,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @route   GET /api/patient/exercise-log/today-stats
 * @desc    Today's assigned exercises (scoped to today's day-group, same
 *          rotation the diet plan uses) joined with what's actually been
 *          logged today, plus the real (server-computed) calorie burn
 *          total. Kept as its own field, never merged into the diet plan's
 *          remainingCalories - see the Exercise Plan feature plan's
 *          "Architecture decisions" for why.
 * @access  Private (Patient)
 */
exports.getTodayExerciseStats = async (req, res, next) => {
  try {
    const patientId = req.user._id;
    const queryDate = req.query.date;
    const today = queryDate ? new Date(queryDate) : new Date();
    const todayDayGroup = resolveDayGroupForDate(today);

    const plan = await ExercisePlan.findOne({ patientId, status: 'Active' })
      .populate('dailyExercises.exerciseId')
      .lean();

    const todaysPlanned = (plan?.dailyExercises || []).filter(
      (entry) => entry.dayGroup === todayDayGroup
    );

    const existingLog = await ExerciseLog.findOne({
      patientId,
      date: { $gte: getStartOfDay(today), $lte: getEndOfDay(today) },
    }).lean();
    const loggedExercises = existingLog?.exercises || [];

    const plannedExercises = todaysPlanned.map((entry) => {
      const logged = loggedExercises.find(
        (e) => e.exerciseId?.toString() === entry.exerciseId?._id?.toString()
      );
      return {
        exerciseId: entry.exerciseId?._id,
        name: entry.exerciseId?.name || null,
        category: entry.exerciseId?.category || null,
        image: entry.exerciseId?.image || null,
        description: entry.exerciseId?.description || null,
        videoUrl: entry.exerciseId?.videoUrl || null,
        instructions: entry.exerciseId?.instructions || [],
        translations: entry.exerciseId?.translations || {},
        durationMinutes: entry.durationMinutes,
        sets: entry.sets,
        reps: entry.reps,
        isLogged: !!logged,
        loggedCaloriesBurned: logged?.caloriesBurned || 0,
      };
    });

    const totalCaloriesBurned = Math.round(
      loggedExercises.reduce((sum, e) => sum + (e.caloriesBurned || 0), 0)
    );
    const completedCount = plannedExercises.filter((e) => e.isLogged).length;

    return res.status(200).json({
      success: true,
      data: {
        plannedExercises,
        totalCaloriesBurned,
        completedCount,
        totalExercises: plannedExercises.length,
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @route   POST /api/patient/exercise-log
 * @desc    Log completed exercise(s) for a day - overwrite-or-append per
 *          exerciseId (mirrors submitMealLog's overwrite-or-append per
 *          (servingTime, recipeId), just keyed on exerciseId alone since
 *          there's no time-slot concept here). caloriesBurned is always
 *          computed server-side (met * weightKg * durationHours) - any
 *          client-sent calorie figure is ignored outright.
 *
 *          durationMinutes is optional from the client (see
 *          exercise_view.dart - the patient can leave it blank): when
 *          absent, it's estimated from the patient's active plan entry
 *          and/or the exercise catalog's secondsPerRep via
 *          estimateDurationMinutes - see that function's own doc comment.
 * @access  Private (Patient)
 */
exports.submitExerciseLog = async (req, res, next) => {
  try {
    const patientId = req.user._id;
    const { date, exercises } = req.body || {};

    const rawDate = date ? new Date(date) : new Date();
    if (Number.isNaN(rawDate.getTime())) {
      return res.status(400).json({ success: false, message: 'Invalid date' });
    }
    const targetDate = normalizeDate(rawDate);
    const today = normalizeDate(new Date());
    // Reject only a future date - a patient logs exercise they *did*, which
    // can only ever be today or an earlier day (mirrors dietController.js's
    // submitMealLog day-strip logging). This used to reject the opposite
    // direction (blocking every past-day submission with "Cannot modify
    // past exercise logs" while allowing future ones), which is exactly
    // backwards from the intended rule.
    if (targetDate > today) {
      return res.status(400).json({
        success: false,
        message: 'Cannot log exercise for a future date',
      });
    }

    if (!Array.isArray(exercises) || exercises.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'exercises must be a non-empty array',
      });
    }
    for (const item of exercises) {
      if (!mongoose.Types.ObjectId.isValid(item.exerciseId)) {
        return res.status(400).json({
          success: false,
          message: 'Each exercise needs a valid exerciseId',
        });
      }
      if (item.durationMinutes != null && (typeof item.durationMinutes !== 'number' || item.durationMinutes <= 0)) {
        return res.status(400).json({
          success: false,
          message: 'durationMinutes must be a positive number when provided',
        });
      }
    }

    const exerciseIds = [...new Set(exercises.map((e) => e.exerciseId))];
    const exerciseDocs = await Exercise.find({ _id: { $in: exerciseIds } }).select('met secondsPerRep').lean();
    const exerciseById = new Map(exerciseDocs.map((e) => [e._id.toString(), e]));

    const activePlan = await ExercisePlan.findOne({ patientId, status: 'Active' }).select('dailyExercises').lean();
    const planEntryByExerciseId = new Map(
      (activePlan?.dailyExercises || []).map((e) => [e.exerciseId.toString(), e])
    );

    let weightKg = await resolvePatientWeightKg(patientId);
    let usedFallbackWeight = false;
    if (weightKg == null) {
      weightKg = DEFAULT_FALLBACK_WEIGHT_KG;
      usedFallbackWeight = true;
    }

    // Resolve each item's real durationMinutes (client-sent, or estimated)
    // up front so a single unresolvable item fails the whole request before
    // any DB write, same as the exerciseId/durationMinutes validation above.
    const resolvedExercises = [];
    for (const item of exercises) {
      const planEntry = planEntryByExerciseId.get(item.exerciseId);
      const sets = item.sets ?? planEntry?.sets ?? null;
      const reps = item.reps ?? planEntry?.reps ?? null;

      let durationMinutes = typeof item.durationMinutes === 'number' && item.durationMinutes > 0
        ? item.durationMinutes
        : null;

      if (durationMinutes == null) {
        const exerciseDoc = exerciseById.get(item.exerciseId);
        const estimated = estimateDurationMinutes({
          planDurationMinutes: planEntry?.durationMinutes ?? null,
          sets,
          reps,
          secondsPerRep: exerciseDoc?.secondsPerRep ?? null,
        });
        if (estimated == null) {
          return res.status(400).json({
            success: false,
            message: 'Enter how many minutes you did this exercise for',
          });
        }
        durationMinutes = Math.max(1, Math.round(estimated));
      }

      resolvedExercises.push({ ...item, durationMinutes, sets, reps });
    }

    let log = await ExerciseLog.findOne({
      patientId,
      date: { $gte: getStartOfDay(targetDate), $lte: getEndOfDay(targetDate) },
    });
    if (!log) {
      log = new ExerciseLog({ patientId, date: targetDate, exercises: [] });
    }

    resolvedExercises.forEach((item) => {
      const met = exerciseById.get(item.exerciseId)?.met;
      const caloriesBurned = calcCaloriesBurned({
        met,
        weightKg,
        durationMinutes: item.durationMinutes,
      }) || 0;

      const existingIndex = log.exercises.findIndex(
        (e) => e.exerciseId.toString() === item.exerciseId
      );
      const entry = {
        exerciseId: item.exerciseId,
        durationMinutes: item.durationMinutes,
        sets: item.sets ?? null,
        reps: item.reps ?? null,
        caloriesBurned,
        completedAt: new Date(),
        notes: item.notes,
      };
      if (existingIndex >= 0) {
        log.exercises[existingIndex] = entry;
      } else {
        log.exercises.push(entry);
      }
    });

    log.totalCaloriesBurned = Math.round(
      log.exercises.reduce((sum, e) => sum + (e.caloriesBurned || 0), 0)
    );
    await log.save();

    return res.status(200).json({
      success: true,
      data: { log, usedFallbackWeight },
    });
  } catch (error) {
    next(error);
  }
};
