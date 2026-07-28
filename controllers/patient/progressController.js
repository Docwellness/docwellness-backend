/**
 * Patient Progress Controller
 * Handles progress tracking operations for patients
 */

const fs = require('fs/promises');
const { Progress, User, MealLog } = require('../../models');
const { calculateBMI } = require('../../utils/helpers');
const cloudinary = require('../../config/cloudinary');
const { cloudinaryUserFolder } = require('../../utils/cloudinaryFolder');
const { calcAge, calcBmr, calcTdee } = require('../../utils/dieticianPatientHelpers');

/**
 * @desc    Create a new progress entry
 * @route   POST /api/patient/progress
 * @access  Private (Patient)
 */
exports.createProgress = async (req, res, next) => {
  try {
    const { date, weight, notes, beforeImage, afterImage, arm, waist, hip } = req.body;

    // Get user's height for BMI calculation
    const user = await User.findById(req.user._id).select('healthProfile');
    const height = user.healthProfile?.height;

    // Calculate BMI if weight and height are available
    let bmi = null;
    if (weight && height) {
      bmi = parseFloat(calculateBMI(weight, height));
    }

    // Calculate adherence based on meal logs (if applicable)
    const adherence = await calculateAdherence(req.user._id, date);

    // Handle body image file uploads (sent as multipart from Flutter app)
    // Accept both 'bodyImage' (new) and 'beforeImage' (legacy) field names
    let bodyImageUrl = '';
    const imageFile =
      (req.files && req.files.bodyImage && req.files.bodyImage[0]) ||
      (req.files && req.files.beforeImage && req.files.beforeImage[0]);
    if (imageFile) {
      const filePath = imageFile.path;
      const uploadResult = await cloudinary.uploader.upload(filePath, {
        folder: cloudinaryUserFolder(req.user._id, 'progress'),
      });
      bodyImageUrl = uploadResult.secure_url;
      await fs.unlink(filePath).catch(() => {});
    }

    // Handle second body image upload (e.g. side view)
    let bodyImage2Url = '';
    if (req.files && req.files.bodyImage2 && req.files.bodyImage2[0]) {
      const filePath2 = req.files.bodyImage2[0].path;
      const uploadResult2 = await cloudinary.uploader.upload(filePath2, {
        folder: cloudinaryUserFolder(req.user._id, 'progress'),
      });
      bodyImage2Url = uploadResult2.secure_url;
      await fs.unlink(filePath2).catch(() => {});
    }

    const progress = await Progress.create({
      patientId: req.user._id,
      date: date || new Date(),
      weight,
      bmi,
      arm: arm ? parseFloat(arm) : undefined,
      waist: waist ? parseFloat(waist) : undefined,
      hip: hip ? parseFloat(hip) : undefined,
      adherence,
      notes,
      bodyImage: bodyImageUrl,
      bodyImage2: bodyImage2Url,
      beforeImage,
      afterImage,
    });

    // Update user's health profile with new weight and body measurements
    const profileUpdate = {};
    if (weight) profileUpdate['healthProfile.weight'] = weight;
    if (arm) profileUpdate['healthProfile.arm'] = parseFloat(arm);
    if (waist) profileUpdate['healthProfile.waist'] = parseFloat(waist);
    if (hip) profileUpdate['healthProfile.hip'] = parseFloat(hip);

    if (Object.keys(profileUpdate).length > 0) {
      await User.findByIdAndUpdate(req.user._id, profileUpdate);
    }

    res.status(201).json({
      success: true,
      message: 'Progress recorded successfully',
      data: progress,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Get all progress entries
 * @route   GET /api/patient/progress
 * @access  Private (Patient)
 */
exports.getProgress = async (req, res, next) => {
  try {
    const { startDate, endDate, page = 1, limit = 10 } = req.query;

    const query = { patientId: req.user._id };

    // Date range filter
    if (startDate || endDate) {
      query.date = {};
      if (startDate) query.date.$gte = new Date(startDate);
      if (endDate) query.date.$lte = new Date(endDate);
    }

    const progress = await Progress.find(query)
      .sort({ date: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit))
      .lean();

    const total = await Progress.countDocuments(query);

    res.status(200).json({
      success: true,
      data: progress,
      pagination: {
        total,
        page: parseInt(page),
        pages: Math.ceil(total / limit),
        hasMore: page < Math.ceil(total / limit),
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Get progress by ID
 * @route   GET /api/patient/progress/:id
 * @access  Private (Patient)
 */
exports.getProgressById = async (req, res, next) => {
  try {
    const progress = await Progress.findOne({
      _id: req.params.id,
      patientId: req.user._id,
    }).lean();

    if (!progress) {
      return res.status(404).json({
        success: false,
        message: 'Progress record not found',
      });
    }

    res.status(200).json({
      success: true,
      data: progress,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Get progress statistics and summary
 * @route   GET /api/patient/progress/stats
 * @access  Private (Patient)
 */
exports.getProgressStats = async (req, res, next) => {
  try {
    const { period = 'month' } = req.query;

    // Calculate date range
    const endDate = new Date();
    const startDate = new Date();

    switch (period) {
      case 'week':
        startDate.setDate(startDate.getDate() - 7);
        break;
      case 'month':
        startDate.setMonth(startDate.getMonth() - 1);
        break;
      case '3months':
        startDate.setMonth(startDate.getMonth() - 3);
        break;
      case 'year':
        startDate.setFullYear(startDate.getFullYear() - 1);
        break;
      default:
        startDate.setMonth(startDate.getMonth() - 1);
    }

    const progressEntries = await Progress.find({
      patientId: req.user._id,
      date: { $gte: startDate, $lte: endDate },
    })
      .sort({ date: 1 })
      .lean();

    if (progressEntries.length === 0) {
      return res.status(200).json({
        success: true,
        data: {
          message: 'No progress data available for this period',
          currentWeight: null,
          weightChange: null,
          bmiChange: null,
          averageAdherence: null,
          totalEntries: 0,
        },
      });
    }

    // Calculate statistics
    const firstEntry = progressEntries[0];
    const lastEntry = progressEntries[progressEntries.length - 1];

    const weightChange =
      lastEntry.weight && firstEntry.weight
        ? (lastEntry.weight - firstEntry.weight).toFixed(2)
        : null;

    const bmiChange =
      lastEntry.bmi && firstEntry.bmi ? (lastEntry.bmi - firstEntry.bmi).toFixed(2) : null;

    // Calculate average adherence
    const adherenceValues = progressEntries.filter((p) => p.adherence != null);
    const averageAdherence =
      adherenceValues.length > 0
        ? (
            adherenceValues.reduce((sum, p) => sum + p.adherence, 0) / adherenceValues.length
          ).toFixed(1)
        : null;

    // Weight trend data for charts
    const weightTrend = progressEntries
      .filter((p) => p.weight)
      .map((p) => ({
        date: p.date,
        weight: p.weight,
        bmi: p.bmi,
      }));

    res.status(200).json({
      success: true,
      data: {
        period,
        currentWeight: lastEntry.weight,
        currentBMI: lastEntry.bmi,
        startWeight: firstEntry.weight,
        startBMI: firstEntry.bmi,
        weightChange: parseFloat(weightChange),
        bmiChange: parseFloat(bmiChange),
        averageAdherence: parseFloat(averageAdherence),
        totalEntries: progressEntries.length,
        weightTrend,
        lastRecorded: lastEntry.date,
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Update a progress entry
 * @route   PUT /api/patient/progress/:id
 * @access  Private (Patient)
 */
exports.updateProgress = async (req, res, next) => {
  try {
    const { weight, notes, beforeImage, afterImage, achieved } = req.body;

    let progress = await Progress.findOne({
      _id: req.params.id,
      patientId: req.user._id,
    });

    if (!progress) {
      return res.status(404).json({
        success: false,
        message: 'Progress record not found',
      });
    }

    // Recalculate BMI if weight is updated
    if (weight) {
      const user = await User.findById(req.user._id).select('healthProfile.height');
      if (user.healthProfile?.height) {
        progress.bmi = parseFloat(calculateBMI(weight, user.healthProfile.height));
      }
      progress.weight = weight;

      // Update user's health profile
      await User.findByIdAndUpdate(req.user._id, {
        'healthProfile.weight': weight,
      });
    }

    if (notes !== undefined) progress.notes = notes;
    if (beforeImage !== undefined) progress.beforeImage = beforeImage;
    if (afterImage !== undefined) progress.afterImage = afterImage;
    if (achieved !== undefined) progress.achieved = achieved;

    await progress.save();

    res.status(200).json({
      success: true,
      message: 'Progress updated successfully',
      data: progress,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Delete a progress entry
 * @route   DELETE /api/patient/progress/:id
 * @access  Private (Patient)
 */
exports.deleteProgress = async (req, res, next) => {
  try {
    const progress = await Progress.findOneAndDelete({
      _id: req.params.id,
      patientId: req.user._id,
    });

    if (!progress) {
      return res.status(404).json({
        success: false,
        message: 'Progress record not found',
      });
    }

    res.status(200).json({
      success: true,
      message: 'Progress record deleted successfully',
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Upload progress images (before/after)
 * @route   POST /api/patient/progress/:id/images
 * @access  Private (Patient)
 */
exports.uploadProgressImages = async (req, res, next) => {
  try {
    const { id } = req.params;

    const progress = await Progress.findOne({
      _id: id,
      patientId: req.user._id,
    });

    if (!progress) {
      return res.status(404).json({
        success: false,
        message: 'Progress record not found',
      });
    }

    // Handle uploaded files
    if (req.files) {
      if (req.files.beforeImage) {
        const beforePath = req.files.beforeImage[0]?.path;
        if (beforePath) {
          const uploadResult = await cloudinary.uploader.upload(beforePath, {
            folder: cloudinaryUserFolder(progress.patientId, 'progress'),
          });
          await fs.unlink(beforePath).catch(() => {});
          progress.beforeImage = uploadResult.secure_url;
        }
      }
      if (req.files.afterImage) {
        const afterPath = req.files.afterImage[0]?.path;
        if (afterPath) {
          const uploadResult = await cloudinary.uploader.upload(afterPath, {
            folder: cloudinaryUserFolder(progress.patientId, 'progress'),
          });
          await fs.unlink(afterPath).catch(() => {});
          progress.afterImage = uploadResult.secure_url;
        }
      }
    }

    await progress.save();

    res.status(200).json({
      success: true,
      message: 'Progress images uploaded successfully',
      data: progress,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Get goal progress
 * @route   GET /api/patient/progress/goal
 * @access  Private (Patient)
 */
exports.getGoalProgress = async (req, res, next) => {
  try {
    const user = await User.findById(req.user._id).select('healthProfile');

    if (!user.healthProfile?.goal) {
      return res.status(200).json({
        success: true,
        data: {
          message: 'No goal set. Please update your health profile.',
          goal: null,
        },
      });
    }

    // Get progress entries
    const progressEntries = await Progress.find({ patientId: req.user._id })
      .sort({ date: -1 })
      .limit(30)
      .lean();

    const latestProgress = progressEntries[0];
    const oldestProgress = progressEntries[progressEntries.length - 1];

    let goalStatus = {
      goal: user.healthProfile.goal,
      currentWeight: latestProgress?.weight,
      startWeight: oldestProgress?.weight,
      progress: null,
      onTrack: null,
    };

    // Determine if on track based on goal
    if (latestProgress?.weight && oldestProgress?.weight) {
      const weightDiff = latestProgress.weight - oldestProgress.weight;

      switch (user.healthProfile.goal) {
        case 'Weight Loss':
          goalStatus.onTrack = weightDiff < 0;
          goalStatus.progress = `${Math.abs(weightDiff).toFixed(1)} kg ${weightDiff < 0 ? 'lost' : 'gained'}`;
          break;
        case 'Weight Gain':
          goalStatus.onTrack = weightDiff > 0;
          goalStatus.progress = `${Math.abs(weightDiff).toFixed(1)} kg ${weightDiff > 0 ? 'gained' : 'lost'}`;
          break;
        default:
          goalStatus.progress = 'Tracking in progress';
      }
    }

    res.status(200).json({
      success: true,
      data: goalStatus,
    });
  } catch (error) {
    next(error);
  }
};

// ============================================================
// Patient: get own tracking data (calorie, weight, BMI trends)
// GET /api/patient/tracking-data?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
// ============================================================

// Helper: get local date string YYYY-MM-DD without timezone shift
function localDateStr(date) {
  const d = new Date(date);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
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

// Helper: sum meal calories from meals array
function sumMealCalories(meals) {
  if (!Array.isArray(meals)) return 0;
  return meals.reduce((sum, meal) => sum + (meal.caloriesConsumed || 0), 0);
}

function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Splits [rangeStart, rangeEnd] into buckets sized to keep the chart
// readable regardless of how wide a range the patient picks - they choose
// any start/end date (bounded by the plan's real start and today), not a
// fixed week/month/year, so bucketing has to scale with whatever range that
// turns out to be: a bar per day for a short range, growing to weekly then
// monthly as the range widens.
function buildDateBuckets(rangeStart, rangeEnd) {
  const start = new Date(rangeStart);
  start.setHours(0, 0, 0, 0);
  const end = new Date(rangeEnd);
  end.setHours(0, 0, 0, 0);
  const totalDays = Math.round((end.getTime() - start.getTime()) / MS_PER_DAY) + 1;

  let granularity;
  if (totalDays <= 14) granularity = 'daily';
  else if (totalDays <= 84) granularity = 'weekly';
  else granularity = 'monthly';

  const buckets = [];

  if (granularity === 'daily') {
    for (let d = new Date(start); d <= end; d = addDays(d, 1)) {
      const bStart = new Date(d);
      bStart.setHours(0, 0, 0, 0);
      const bEnd = new Date(d);
      bEnd.setHours(23, 59, 59, 999);
      buckets.push({ start: bStart, end: bEnd, label: formatShortDate(bStart) });
    }
  } else if (granularity === 'weekly') {
    let cur = new Date(start);
    while (cur <= end) {
      const bStart = new Date(cur);
      bStart.setHours(0, 0, 0, 0);
      const bEndRaw = addDays(cur, 6) > end ? new Date(end) : addDays(cur, 6);
      const bEnd = new Date(bEndRaw);
      bEnd.setHours(23, 59, 59, 999);
      buckets.push({ start: bStart, end: bEnd, label: formatShortDate(bStart) });
      cur = addDays(cur, 7);
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
    const spansMultipleYears = start.getFullYear() !== end.getFullYear();
    let cur = new Date(start.getFullYear(), start.getMonth(), 1);
    while (cur <= end) {
      const bStart = cur > start ? new Date(cur) : new Date(start);
      bStart.setHours(0, 0, 0, 0);
      const calendarMonthEnd = new Date(cur.getFullYear(), cur.getMonth() + 1, 0);
      const bEndRaw = calendarMonthEnd < end ? calendarMonthEnd : end;
      const bEnd = new Date(bEndRaw);
      bEnd.setHours(23, 59, 59, 999);
      const label = spansMultipleYears
        ? `${monthNames[cur.getMonth()]} '${String(cur.getFullYear()).slice(2)}`
        : monthNames[cur.getMonth()];
      buckets.push({ start: bStart, end: bEnd, label });
      cur = new Date(cur.getFullYear(), cur.getMonth() + 1, 1);
    }
  }

  return { buckets, granularity };
}

exports.getTrackingData = async (req, res, next) => {
  try {
    const patientId = req.user._id;

    const patient = await User.findById(patientId)
      .select('healthProfile profile.gender profile.dateOfBirth')
      .lean();
    if (!patient) {
      return res.status(404).json({ success: false, message: 'Patient not found' });
    }

    const healthProfile = patient.healthProfile || {};
    const profile = patient.profile || {};
    const latestProgressWithWeight = await Progress.findOne({
      patientId,
      weight: { $exists: true, $ne: null },
    })
      .sort({ date: -1 })
      .select('weight bmi')
      .lean();

    const currentWeight = latestProgressWithWeight?.weight || healthProfile.weight || 70;
    const rawHeight = healthProfile.height || 170;
    const height = rawHeight >= 100 ? rawHeight : 170;
    const activityLevel = healthProfile.activityLevel || 'Moderate';
    const rawTargetWeight = healthProfile.targetWeight;
    const targetWeight =
      typeof rawTargetWeight === 'number'
        ? rawTargetWeight
        : parseFloat(String(rawTargetWeight || '').replace(/[^0-9.-]/g, '')) || 0;
    const healthConcerns = healthProfile.healthConcerns || healthProfile.illnessAttention || [];

    // Get active diet plan for planned calories
    const { DietPlan } = require('../../models');
    const activePlan = await DietPlan.findOne({ patientId, status: 'Active' })
      .sort({ createdAt: -1 })
      .select('totalCalories weeksSummary activationDate weekSchedule')
      .lean();

    const plannedDailyCalories =
      activePlan?.totalCalories || activePlan?.weeksSummary?.[0]?.totalCalories || 2000;

    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    // The plan's real start date - prefers weekSchedule's week-1 start (the
    // same source dietController.js's weekStartDate/dietEnabled derive from)
    // over activationDate, which can predate the plan's real first week.
    // This is the earliest date this endpoint will ever show data for -
    // there's nothing meaningful to chart before it.
    const resolvedPlanStart = activePlan?.weekSchedule?.[0]?.startDate
      ? new Date(activePlan.weekSchedule[0].startDate)
      : activePlan?.activationDate
        ? new Date(activePlan.activationDate)
        : null;
    if (resolvedPlanStart) resolvedPlanStart.setHours(0, 0, 0, 0);

    // Requested range - each chart (Weight/BMI/Calorie) picks its own
    // start/end independently client-side. Defaults to [plan start, today]
    // (the patient's whole history so far) and is clamped so a stale/
    // tampered query can't ask for dates before the plan started or after
    // today - no data exists outside that window either way.
    const earliestAllowed = resolvedPlanStart || today;
    let startDate = req.query.startDate ? new Date(req.query.startDate) : earliestAllowed;
    let endDate = req.query.endDate ? new Date(req.query.endDate) : today;
    if (Number.isNaN(startDate.getTime())) startDate = earliestAllowed;
    if (Number.isNaN(endDate.getTime())) endDate = today;
    startDate.setHours(0, 0, 0, 0);
    endDate.setHours(0, 0, 0, 0);
    if (startDate < earliestAllowed) startDate = new Date(earliestAllowed);
    if (endDate > today) endDate = new Date(today);
    if (startDate > endDate) startDate = new Date(endDate);
    endDate.setHours(23, 59, 59, 999);

    // Fetch meal logs
    const mealLogs = await MealLog.find({
      patientId,
      date: { $gte: startDate, $lte: endDate },
    })
      .sort({ date: 1 })
      .select('date totalCalories meals')
      .lean();

    // TDEE calculation - real age/gender from the patient's profile, not a
    // hardcoded age-30/always-male assumption.
    const age = calcAge(profile.dateOfBirth) || 30;
    const bmr = calcBmr({ weight: currentWeight, height, age, gender: profile.gender }) || 1800;
    const tdee = calcTdee(bmr, activityLevel) || bmr * 1.55;

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

    // Weight trend from calorie surplus/deficit - cumulative from the
    // plan's real start (not just the visible range's start) so a bucket
    // partway through the plan still reflects the real trajectory, instead
    // of one that resets to currentWeight at whatever start date the
    // patient happens to have picked for this chart.
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
      // Compare calendar days, not exact instants - bucket.start is already
      // day-normalized (see buildDateBuckets), but `now` carries a
      // time-of-day. Comparing it against `now` directly could misfire a
      // bucket that starts "today" into the future branch depending on the
      // time of day, which is exactly what made a freshly-started plan's
      // very first (and only) reading come back zeroed out instead of
      // showing the patient's actual current weight.
      if (bucket.start > today) {
        return { label: bucket.label, date: '', weight: 0 };
      }
      const effectiveEnd = bucket.end > now ? now : bucket.end;
      const dayStr = localDateStr(effectiveEnd);
      // The very first reading is never allowed to come back as an unlogged
      // zero - if this is a fresh plan's first bucket and there's no
      // cumulative-weight entry for it yet, it should read as the patient's
      // actual current weight, not nothing.
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

    // BMI trend
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

    // Which bucket "today" falls into, so the chart can highlight it - -1
    // (no highlight) when the picked range doesn't include today at all
    // (e.g. the patient is looking at an earlier stretch of history).
    let currentIndex = -1;
    for (let i = 0; i < buckets.length; i++) {
      if (now >= buckets[i].start && now <= buckets[i].end) {
        currentIndex = i;
        break;
      }
    }

    // ── Body measurements (latest from progress entries) ──
    const latestWithArm = await Progress.findOne({ patientId, arm: { $exists: true, $ne: null } })
      .sort({ date: -1 })
      .select('arm')
      .lean();
    const latestWithWaist = await Progress.findOne({
      patientId,
      waist: { $exists: true, $ne: null },
    })
      .sort({ date: -1 })
      .select('waist')
      .lean();
    const latestWithHip = await Progress.findOne({ patientId, hip: { $exists: true, $ne: null } })
      .sort({ date: -1 })
      .select('hip')
      .lean();

    const bodyMeasurements = {
      arm: latestWithArm?.arm || healthProfile.arm || 0,
      waist: latestWithWaist?.waist || healthProfile.waist || 0,
      hip: latestWithHip?.hip || healthProfile.hip || 0,
    };

    // ── Achievements (computed from real progress data) ──
    const achievements = [];

    // Weight-loss achievements only mean something once the diet plan has
    // actually been running for a full week AND a weight was logged at/after
    // that point - otherwise "Making progress" would fire off whatever
    // weight happened to be on file before the plan even started (e.g. an
    // old healthProfile value vs today's first log), which isn't real
    // progress on THIS plan.
    const firstWeekComplete =
      resolvedPlanStart && now - resolvedPlanStart >= 7 * 24 * 60 * 60 * 1000;

    // Check weight loss achievement: lost > 2 kg in any 7-day window
    const allProgressEntries = firstWeekComplete
      ? await Progress.find({
          patientId,
          weight: { $exists: true, $ne: null },
          date: { $gte: resolvedPlanStart },
        })
          .sort({ date: 1 })
          .select('date weight')
          .lean()
      : [];

    // Also require an entry logged at/after the end of week 1 - a plan
    // that's only a few days in shouldn't show "Making progress" just
    // because two early logs happened to differ.
    const weekOneEnd = resolvedPlanStart ? addDays(resolvedPlanStart, 7) : null;
    const hasWeekOneLog =
      weekOneEnd && allProgressEntries.some((p) => new Date(p.date) >= weekOneEnd);

    if (hasWeekOneLog && allProgressEntries.length >= 2) {
      const firstW = allProgressEntries[0].weight;
      const lastW = allProgressEntries[allProgressEntries.length - 1].weight;
      const totalLoss = firstW - lastW;

      // Check for any 7-day window with > 2kg loss
      let bestWeeklyLoss = 0;
      for (let i = 0; i < allProgressEntries.length; i++) {
        for (let j = i + 1; j < allProgressEntries.length; j++) {
          const daysDiff =
            (new Date(allProgressEntries[j].date) - new Date(allProgressEntries[i].date)) /
            (1000 * 60 * 60 * 24);
          if (daysDiff <= 7 && daysDiff > 0) {
            const loss = allProgressEntries[i].weight - allProgressEntries[j].weight;
            if (loss > bestWeeklyLoss) bestWeeklyLoss = loss;
          }
        }
      }

      if (bestWeeklyLoss > 2) {
        achievements.push({
          type: 'weight_loss',
          title: 'Big achievement',
          description: `Lost ${bestWeeklyLoss.toFixed(1)} kg in a single week!`,
          icon: 'badge',
        });
      } else if (totalLoss > 0) {
        achievements.push({
          type: 'weight_loss',
          title: 'Making progress',
          description: `Lost ${totalLoss.toFixed(1)} kg since starting. Keep it up!`,
          icon: 'badge',
        });
      }
    }

    // Check calorie adherence streak: consecutive days within planned calories
    let calorieStreak = 0;
    let maxCalorieStreak = 0;
    for (const day of calorieData) {
      if (day.calories > 0 && day.calories <= day.plannedCalories) {
        calorieStreak++;
        if (calorieStreak > maxCalorieStreak) maxCalorieStreak = calorieStreak;
      } else if (day.calories > 0) {
        calorieStreak = 0;
      }
    }

    if (maxCalorieStreak >= 3) {
      achievements.push({
        type: 'calorie_adherence',
        title: 'Calorie champion',
        description: `Stayed within calorie plan for ${maxCalorieStreak} consecutive days!`,
        icon: 'trophy',
      });
    } else if (maxCalorieStreak >= 1) {
      achievements.push({
        type: 'calorie_adherence',
        title: 'On track',
        description: `Stayed within calorie plan for ${maxCalorieStreak} day${maxCalorieStreak > 1 ? 's' : ''}. Keep going!`,
        icon: 'trophy',
      });
    }

    // Logging consistency achievement
    const totalLoggedDays = calorieData.filter((d) => d.calories > 0).length;
    if (totalLoggedDays >= 5) {
      achievements.push({
        type: 'consistency',
        title: 'Consistent logger',
        description: `Logged meals for ${totalLoggedDays} days in this range!`,
        icon: 'star',
      });
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
        currentBmi:
          latestProgressWithWeight?.bmi ||
          Math.round((currentWeight / (heightInMeters * heightInMeters)) * 10) / 10,
        targetWeight: targetWeight || 0,
        activityLevel,
        healthConcerns: Array.isArray(healthConcerns) ? healthConcerns : [],
        plannedDailyCalories,
        tdee: Math.round(tdee),
        bodyMeasurements,
        achievements,
        calorieData,
        weightTrend,
        bmiTrend,
      },
    });
  } catch (error) {
    next(error);
  }
};

// Helper function to calculate adherence
async function calculateAdherence(patientId, date) {
  try {
    const targetDate = date ? new Date(date) : new Date();
    targetDate.setHours(0, 0, 0, 0);

    // Check if meal log exists for the date
    const mealLog = await MealLog.findOne({
      patientId,
      date: {
        $gte: targetDate,
        $lt: new Date(targetDate.getTime() + 24 * 60 * 60 * 1000),
      },
    });

    if (!mealLog) return 0;

    // Calculate adherence based on number of meals logged
    // Assuming 3 main meals (breakfast, lunch, dinner) is 100%
    const expectedMeals = 3;
    const loggedMainMeals = mealLog.meals.filter((m) =>
      ['Breakfast', 'Lunch', 'Dinner'].includes(m.mealType)
    ).length;

    return Math.min(100, Math.round((loggedMainMeals / expectedMeals) * 100));
  } catch (error) {
    return null;
  }
}
