/**
 * Patient Journey Controller
 * Handles journey image uploads and retrieval for patients
 */

const JourneyImage = require('../../models/JourneyImage');
const Progress = require('../../models/Progress');
const cloudinary = require('../../config/cloudinary');
const { cloudinaryUserFolder } = require('../../utils/cloudinaryFolder');
const config = require('../../config/environment');
const fs = require('fs').promises;

/**
 * @desc    Upload journey images (before and/or after)
 * @route   POST /api/patient/journey
 * @access  Private (Patient)
 */
exports.uploadJourneyImage = async (req, res, next) => {
  try {
    const patientId = req.user._id;
    const dieticianId = config.defaultDieticianId;
    const { description, dayLabel } = req.body;

    const beforeFile = req.files?.beforeImage?.[0];
    const afterFile = req.files?.afterImage?.[0];

    if (!beforeFile && !afterFile) {
      return res.status(400).json({
        success: false,
        message: 'At least one image (before or after) is required',
      });
    }

    let beforeImageUrl = '';
    let afterImageUrl = '';

    // Upload before image to Cloudinary
    if (beforeFile) {
      const result = await cloudinary.uploader.upload(beforeFile.path, {
        folder: cloudinaryUserFolder(patientId, 'journey'),
      });
      beforeImageUrl = result.secure_url;
      await fs.unlink(beforeFile.path).catch(() => {});
    }

    // Upload after image to Cloudinary
    if (afterFile) {
      const result = await cloudinary.uploader.upload(afterFile.path, {
        folder: cloudinaryUserFolder(patientId, 'journey'),
      });
      afterImageUrl = result.secure_url;
      await fs.unlink(afterFile.path).catch(() => {});
    }

    const journeyImage = await JourneyImage.create({
      patientId,
      dieticianId,
      uploadedBy: patientId,
      uploadedByRole: 'patient',
      beforeImageUrl,
      afterImageUrl,
      description: description || '',
      dayLabel: dayLabel || 'Day 1',
    });

    res.status(201).json({
      success: true,
      message: 'Journey images uploaded successfully',
      data: journeyImage,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Get all journey images for the authenticated patient
 * @route   GET /api/patient/journey
 * @access  Private (Patient)
 */
exports.getJourneyImages = async (req, res, next) => {
  try {
    const patientId = req.user._id;

    const images = await JourneyImage.find({ patientId })
      .sort({ createdAt: -1 })
      .populate('uploadedBy', 'fullName');

    res.status(200).json({
      success: true,
      data: images,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Get auto-generated journey (before = first log image, after = latest log image)
 * @route   GET /api/patient/journey/auto
 * @access  Private (Patient)
 */
exports.getAutoJourney = async (req, res, next) => {
  try {
    const patientId = req.user._id;

    // Get the first-ever progress entry with an image
    const firstLog = await Progress.findOne({
      patientId,
      $or: [
        { bodyImage: { $exists: true, $ne: '' } },
        { bodyImage2: { $exists: true, $ne: '' } },
        { beforeImage: { $exists: true, $ne: '' } },
      ],
    }).sort({ date: 1 });

    // Get the latest progress entry with an image
    const latestLog = await Progress.findOne({
      patientId,
      $or: [
        { bodyImage: { $exists: true, $ne: '' } },
        { bodyImage2: { $exists: true, $ne: '' } },
        { beforeImage: { $exists: true, $ne: '' } },
      ],
    }).sort({ date: -1 });

    if (!firstLog) {
      return res.status(200).json({
        success: true,
        data: {
          hasJourney: false,
          message: 'No body images logged yet',
          beforeImage: '',
          afterImage: '',
          dayLabel: 'Day 1',
          firstLogDate: null,
          latestLogDate: null,
        },
      });
    }

    const beforeImage = firstLog.bodyImage || firstLog.beforeImage || '';
    const beforeImage2 = firstLog.bodyImage2 || '';
    const afterImage =
      latestLog && latestLog._id.toString() !== firstLog._id.toString()
        ? latestLog.bodyImage || latestLog.beforeImage || ''
        : '';
    const afterImage2 =
      latestLog && latestLog._id.toString() !== firstLog._id.toString()
        ? latestLog.bodyImage2 || ''
        : '';

    // Calculate day difference
    const dayDiff =
      latestLog && latestLog._id.toString() !== firstLog._id.toString()
        ? Math.ceil((new Date(latestLog.date) - new Date(firstLog.date)) / (1000 * 60 * 60 * 24))
        : 0;

    res.status(200).json({
      success: true,
      data: {
        hasJourney: true,
        beforeImage,
        beforeImage2,
        afterImage,
        afterImage2,
        dayLabel: dayDiff > 0 ? `Day ${dayDiff}` : 'Day 1',
        firstLogDate: firstLog.date,
        latestLogDate: latestLog ? latestLog.date : firstLog.date,
        totalDays: dayDiff || 1,
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Get milestone-based journey cards from body log images
 *          Each card: before = first log image, after = closest image to milestone day
 *          Milestones: Day 1, Day 7, Day 14, Day 30, Day 60, Day 90
 * @route   GET /api/patient/journey/milestones
 * @access  Private (Patient)
 */
exports.getJourneyMilestones = async (req, res, next) => {
  try {
    const patientId = req.user._id;

    // Get all progress entries with images, sorted by date ascending
    const progressLogs = await Progress.find({
      patientId,
      $or: [
        { bodyImage: { $exists: true, $ne: '' } },
        { bodyImage2: { $exists: true, $ne: '' } },
        { beforeImage: { $exists: true, $ne: '' } },
      ],
    }).sort({ date: 1 });

    if (progressLogs.length === 0) {
      return res.status(200).json({
        success: true,
        data: {
          milestones: [],
          firstLogDate: null,
          totalLogsWithImages: 0,
        },
      });
    }

    const firstLog = progressLogs[0];
    const firstLogDate = new Date(firstLog.date);
    const beforeImage = firstLog.bodyImage || firstLog.beforeImage || '';
    const beforeImage2 = firstLog.bodyImage2 || '';

    // Define milestone days
    const milestoneDays = [1, 7, 14, 30, 60, 90];
    const milestones = [];

    // Day 1 card — only the starting image
    milestones.push({
      dayLabel: 'Day 1',
      dayNumber: 1,
      beforeImageUrl: beforeImage,
      afterImageUrl: '',
      date: firstLogDate,
      description: 'Starting point',
      isAutoGenerated: true,
    });

    // For each subsequent milestone, find the closest log with an image
    for (let i = 1; i < milestoneDays.length; i++) {
      const targetDay = milestoneDays[i];
      const targetDate = new Date(firstLogDate);
      targetDate.setDate(targetDate.getDate() + targetDay - 1);

      // Find the log with an image closest to the target date
      let closestLog = null;
      let closestDiff = Infinity;

      for (const log of progressLogs) {
        const logDate = new Date(log.date);
        const diff = Math.abs(logDate - targetDate);
        // Only consider logs within 3 days of the milestone
        if (diff < closestDiff && diff <= 3 * 24 * 60 * 60 * 1000) {
          closestDiff = diff;
          closestLog = log;
        }
      }

      if (closestLog && closestLog._id.toString() !== firstLog._id.toString()) {
        const afterImg = closestLog.bodyImage || closestLog.beforeImage || '';
        const afterImg2 = closestLog.bodyImage2 || '';
        const actualDay =
          Math.ceil((new Date(closestLog.date) - firstLogDate) / (1000 * 60 * 60 * 24)) + 1;

        milestones.push({
          dayLabel: `Day ${actualDay}`,
          dayNumber: actualDay,
          beforeImageUrl: beforeImage,
          beforeImage2Url: beforeImage2,
          afterImageUrl: afterImg,
          afterImage2Url: afterImg2,
          date: closestLog.date,
          description: `Progress at Day ${actualDay}`,
          isAutoGenerated: true,
        });
      }
    }

    // Also add the latest log as a milestone if it's not already included
    const latestLog = progressLogs[progressLogs.length - 1];
    if (latestLog._id.toString() !== firstLog._id.toString()) {
      const latestDay =
        Math.ceil((new Date(latestLog.date) - firstLogDate) / (1000 * 60 * 60 * 24)) + 1;

      // Check if this exact day is already in milestones
      const alreadyIncluded = milestones.some((m) => m.dayNumber === latestDay);

      if (!alreadyIncluded) {
        milestones.push({
          dayLabel: `Day ${latestDay}`,
          dayNumber: latestDay,
          beforeImageUrl: beforeImage,
          beforeImage2Url: beforeImage2,
          afterImageUrl: latestLog.bodyImage || latestLog.beforeImage || '',
          afterImage2Url: latestLog.bodyImage2 || '',
          date: latestLog.date,
          description: 'Latest progress',
          isAutoGenerated: true,
        });
      }
    }

    // Also include manually uploaded journey images
    const manualImages = await JourneyImage.find({ patientId })
      .sort({ createdAt: -1 })
      .populate('uploadedBy', 'fullName');

    res.status(200).json({
      success: true,
      data: {
        milestones,
        manualImages,
        firstLogDate,
        totalLogsWithImages: progressLogs.length,
      },
    });
  } catch (error) {
    next(error);
  }
};
