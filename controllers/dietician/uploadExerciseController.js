// Exercise catalog CRUD - a deliberately scoped-down mirror of
// uploadRecipieController.js. No AI-generation step: a dietician manually
// enters an exercise's name/category/MET value/instructions, unlike
// Recipe's AI-drafted-then-edited flow (there's no "hit a calorie target"
// pressure for exercises the way there is for recipe nutrition).

const Exercise = require('../../models/Exercise');
const cloudinary = require('../../config/cloudinary');
const { cloudinaryUserFolder } = require('../../utils/cloudinaryFolder');
const fs = require('fs');

/**
 * @route   POST /api/dietician/exercises/upload-image
 * @access  Private (Dietician)
 */
exports.uploadExerciseImage = async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'Image file is required',
      });
    }

    const uploadResult = await cloudinary.uploader.upload(req.file.path, {
      folder: cloudinaryUserFolder(req.user._id, 'exercises'),
    });
    await fs.promises.unlink(req.file.path).catch(() => {});
    const imageUrl = uploadResult?.secure_url || uploadResult?.url;

    return res.status(200).json({
      success: true,
      data: {
        url: imageUrl,
        originalName: req.file.originalname,
        mimeType: req.file.mimetype,
        size: req.file.size,
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @route   POST /api/dietician/exercises
 * @access  Private (Dietician)
 */
exports.createExercise = async (req, res, next) => {
  try {
    const dieticianId = req.user._id;
    const {
      name,
      category,
      met,
      instructions,
      equipment,
      difficultyLevel,
      targetMuscleGroups,
      image,
      tags,
    } = req.body || {};

    if (!name || typeof met !== 'number') {
      return res.status(400).json({
        success: false,
        message: 'name and a numeric met value are required',
      });
    }

    const exercise = await Exercise.create({
      dieticianId,
      name,
      category,
      met,
      instructions,
      equipment,
      difficultyLevel,
      targetMuscleGroups,
      image,
      tags,
    });

    return res.status(201).json({
      success: true,
      data: exercise,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @route   GET /api/dietician/exercises
 * @access  Private (Dietician)
 */
exports.listExercises = async (req, res, next) => {
  try {
    const dieticianId = req.user._id;
    const { category, page = '1', limit = '20' } = req.query || {};

    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const limitParsed = parseInt(limit, 10);
    const limitNum = Math.min(Math.max(Number.isNaN(limitParsed) ? 20 : limitParsed, 1), 100);
    const skip = (pageNum - 1) * limitNum;

    const filter = { dieticianId };
    if (category && category !== 'All') {
      filter.category = category;
    }

    const [total, exercises] = await Promise.all([
      Exercise.countDocuments(filter),
      Exercise.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limitNum).lean(),
    ]);

    return res.status(200).json({
      success: true,
      data: exercises,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        hasMore: skip + exercises.length < total,
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @route   GET /api/dietician/exercises/:id
 * @access  Private (Dietician)
 */
exports.getExerciseById = async (req, res, next) => {
  try {
    const dieticianId = req.user._id;
    const { id } = req.params;

    const exercise = await Exercise.findOne({ _id: id, dieticianId }).lean();
    if (!exercise) {
      return res.status(404).json({
        success: false,
        message: 'Exercise not found',
      });
    }

    return res.status(200).json({
      success: true,
      data: exercise,
    });
  } catch (error) {
    next(error);
  }
};

const DIRECT_UPDATE_FIELDS = [
  'name',
  'category',
  'met',
  'instructions',
  'equipment',
  'difficultyLevel',
  'targetMuscleGroups',
  'image',
  'tags',
];

/**
 * @route   PUT /api/dietician/exercises/:id
 * @access  Private (Dietician)
 */
exports.updateExercise = async (req, res, next) => {
  try {
    const dieticianId = req.user._id;
    const { id } = req.params;
    const body = req.body || {};

    const updates = {};
    for (const key of DIRECT_UPDATE_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(body, key)) {
        updates[key] = body[key];
      }
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No updatable fields provided',
      });
    }

    const exercise = await Exercise.findOneAndUpdate(
      { _id: id, dieticianId },
      { $set: updates },
      { new: true, runValidators: true }
    ).lean();

    if (!exercise) {
      return res.status(404).json({
        success: false,
        message: 'Exercise not found',
      });
    }

    return res.status(200).json({
      success: true,
      data: exercise,
    });
  } catch (error) {
    next(error);
  }
};
