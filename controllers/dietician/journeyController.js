/**
 * Dietician Journey Controller
 * Handles journey image CRUD for dieticians viewing/editing patient journeys
 */

const JourneyImage = require('../../models/JourneyImage');
const Progress = require('../../models/Progress');
const cloudinary = require('../../config/cloudinary');
const fs = require('fs').promises;

/**
 * @desc    Get all journey images for a specific patient
 * @route   GET /api/dietician/patients/:patientId/journey
 * @access  Private (Dietician)
 */
exports.getPatientJourneyImages = async (req, res, next) => {
  try {
    const { patientId } = req.params;

    const images = await JourneyImage.find({ patientId })
      .sort({ createdAt: -1 })
      .populate('uploadedBy', 'username fullName');

    res.status(200).json({
      success: true,
      data: images,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Upload journey images for a patient
 * @route   POST /api/dietician/patients/:patientId/journey
 * @access  Private (Dietician)
 */
exports.uploadJourneyImage = async (req, res, next) => {
  try {
    const { patientId } = req.params;
    const dieticianId = req.user._id;
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

    if (beforeFile) {
      const result = await cloudinary.uploader.upload(beforeFile.path, {
        folder: 'docwellness/journey',
      });
      beforeImageUrl = result.secure_url;
      await fs.unlink(beforeFile.path).catch(() => {});
    }

    if (afterFile) {
      const result = await cloudinary.uploader.upload(afterFile.path, {
        folder: 'docwellness/journey',
      });
      afterImageUrl = result.secure_url;
      await fs.unlink(afterFile.path).catch(() => {});
    }

    const journeyImage = await JourneyImage.create({
      patientId,
      dieticianId,
      uploadedBy: dieticianId,
      uploadedByRole: 'dietician',
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
 * @desc    Update a journey image entry (images, description, dayLabel)
 * @route   PUT /api/dietician/patients/:patientId/journey/:imageId
 * @access  Private (Dietician)
 */
exports.updateJourneyImage = async (req, res, next) => {
  try {
    const { patientId, imageId } = req.params;
    const { description, dayLabel } = req.body;

    const journeyImage = await JourneyImage.findOne({
      _id: imageId,
      patientId,
    });

    if (!journeyImage) {
      return res.status(404).json({
        success: false,
        message: 'Journey image not found',
      });
    }

    // Update text fields if provided
    if (description !== undefined) journeyImage.description = description;
    if (dayLabel !== undefined) journeyImage.dayLabel = dayLabel;

    // If new before image is uploaded, replace
    const beforeFile = req.files?.beforeImage?.[0];
    if (beforeFile) {
      const result = await cloudinary.uploader.upload(beforeFile.path, {
        folder: 'docwellness/journey',
      });
      await fs.unlink(beforeFile.path).catch(() => {});
      journeyImage.beforeImageUrl = result.secure_url;
    }

    // If new after image is uploaded, replace
    const afterFile = req.files?.afterImage?.[0];
    if (afterFile) {
      const result = await cloudinary.uploader.upload(afterFile.path, {
        folder: 'docwellness/journey',
      });
      await fs.unlink(afterFile.path).catch(() => {});
      journeyImage.afterImageUrl = result.secure_url;
    }

    await journeyImage.save();

    res.status(200).json({
      success: true,
      message: 'Journey image updated successfully',
      data: journeyImage,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Delete a journey image entry
 * @route   DELETE /api/dietician/patients/:patientId/journey/:imageId
 * @access  Private (Dietician)
 */
exports.deleteJourneyImage = async (req, res, next) => {
  try {
    const { patientId, imageId } = req.params;

    const journeyImage = await JourneyImage.findOneAndDelete({
      _id: imageId,
      patientId,
    });

    if (!journeyImage) {
      return res.status(404).json({
        success: false,
        message: 'Journey image not found',
      });
    }

    res.status(200).json({
      success: true,
      message: 'Journey image deleted successfully',
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Get auto-generated journey for a patient (before = first log image, after = latest)
 * @route   GET /api/dietician/patients/:patientId/journey/auto
 * @access  Private (Dietician)
 */
exports.getAutoJourney = async (req, res, next) => {
  try {
    const { patientId } = req.params;

    const firstLog = await Progress.findOne({
      patientId,
      $or: [
        { bodyImage: { $exists: true, $ne: '' } },
        { bodyImage2: { $exists: true, $ne: '' } },
        { beforeImage: { $exists: true, $ne: '' } },
      ],
    }).sort({ date: 1 });

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
 * @desc    Get milestone-based journey cards for a patient
 * @route   GET /api/dietician/patients/:patientId/journey/milestones
 * @access  Private (Dietician)
 */
exports.getJourneyMilestones = async (req, res, next) => {
  try {
    const { patientId } = req.params;

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

    const milestoneDays = [1, 7, 14, 30, 60, 90];
    const milestones = [];

    milestones.push({
      dayLabel: 'Day 1',
      dayNumber: 1,
      beforeImageUrl: beforeImage,
      afterImageUrl: '',
      date: firstLogDate,
      description: 'Starting point',
      isAutoGenerated: true,
    });

    for (let i = 1; i < milestoneDays.length; i++) {
      const targetDay = milestoneDays[i];
      const targetDate = new Date(firstLogDate);
      targetDate.setDate(targetDate.getDate() + targetDay - 1);

      let closestLog = null;
      let closestDiff = Infinity;

      for (const log of progressLogs) {
        const logDate = new Date(log.date);
        const diff = Math.abs(logDate - targetDate);
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

    const manualImages = await JourneyImage.find({ patientId })
      .sort({ createdAt: -1 })
      .populate('uploadedBy', 'username fullName');

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
