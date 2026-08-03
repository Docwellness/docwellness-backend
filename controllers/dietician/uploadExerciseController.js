// Exercise catalog CRUD - a scoped-down mirror of uploadRecipieController.js.
// AI-generation now covers category/met/description/instructions/equipment/
// difficulty/targetMuscleGroups from just a name (generateExercisePreview
// below), the same "draft then dietician reviews/edits" flow recipes use.
// videoUrl is the one field that stays manual - a demo/tutorial link the
// dietician pastes in - since the AI can't verify a real video exists at a
// URL it invents, unlike the text fields it's authoring itself.

const Exercise = require('../../models/Exercise');
const GenerationLog = require('../../models/GenerationLog');
const config = require('../../config/environment');
const { generateExerciseWithAI } = require('../../utils/openaiClient');
const { calcCaloriesBurned, DEFAULT_FALLBACK_WEIGHT_KG } = require('../../utils/exerciseHelpers');
const cloudinary = require('../../config/cloudinary');
const { cloudinaryUserFolder } = require('../../utils/cloudinaryFolder');
const crypto = require('crypto');
const fs = require('fs');

// A fixed reference session length so the AI-preview's displayed calorie
// figure is comparable across exercises - the real per-log calorie burn
// always uses the patient's actual weight and the duration they logged (see
// controllers/patient/exerciseController.js's submitExerciseLog), this is
// purely a "what does this look like for a typical adult" preview number.
const REFERENCE_DURATION_MINUTES = 30;

const hashExerciseInput = ({ name, category }) =>
  crypto.createHash('sha256').update(JSON.stringify({ name, category: category || '' })).digest('hex');

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
 * @desc    Generate an exercise catalog entry preview using AI - category,
 *          met, description, instructions, equipment, difficulty, and target
 *          muscle groups from just a name (+ optional category hint).
 *          Mirrors uploadRecipieController.js's generateRecipeWithAI preview
 *          endpoint: the dietician reviews/edits the draft before saving via
 *          createExercise, nothing is persisted here.
 * @route   POST /api/dietician/exercises/ai-generate-preview
 * @access  Private (Dietician)
 * @body    { name, category?, language? } - language is a comma-separated
 *          string, e.g. "English,Hindi,Marathi", same convention as the
 *          recipe generation endpoint.
 */
exports.generateExercisePreview = async (req, res, next) => {
  try {
    const { name, category, language } = req.body || {};
    if (!name || !name.trim()) {
      return res.status(400).json({
        success: false,
        message: 'name is required',
      });
    }

    const languages = language
      ? language.split(',').map((l) => l.trim()).filter(Boolean)
      : ['English'];

    const inputHash = hashExerciseInput({ name, category });
    const generationStartedAt = Date.now();
    let generated;
    try {
      generated = await generateExerciseWithAI({ name, category, languages });
    } catch (aiError) {
      console.error('AI error in generateExercisePreview:', aiError);
      try {
        await GenerationLog.create({
          kind: 'exercise',
          dieticianId: req.user._id,
          model: config.openai.recipeModel,
          inputHash,
          latencyMs: Date.now() - generationStartedAt,
          succeeded: false,
        });
      } catch (logError) {
        console.error('Failed to write GenerationLog entry:', logError.message);
      }
      return res.status(502).json({
        success: false,
        message: 'AI service error. Please try again later.',
      });
    }

    // Reference-only figure for a typical adult at a fixed session length -
    // never persisted, never trusted for an actual logged completion (see
    // REFERENCE_DURATION_MINUTES's own comment above).
    const referenceCaloriesBurned = calcCaloriesBurned({
      met: generated.met,
      weightKg: DEFAULT_FALLBACK_WEIGHT_KG,
      durationMinutes: REFERENCE_DURATION_MINUTES,
    });

    try {
      await GenerationLog.create({
        kind: 'exercise',
        dieticianId: req.user._id,
        model: config.openai.recipeModel,
        inputHash,
        latencyMs: Date.now() - generationStartedAt,
        succeeded: true,
      });
    } catch (logError) {
      console.error('Failed to write GenerationLog entry:', logError.message);
    }

    return res.status(200).json({
      success: true,
      data: {
        ...generated,
        language: languages,
        referenceCaloriesBurned,
        referenceDurationMinutes: REFERENCE_DURATION_MINUTES,
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
      secondsPerRep,
      description,
      instructions,
      equipment,
      difficultyLevel,
      targetMuscleGroups,
      image,
      videoUrl,
      tags,
      language,
      translations,
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
      secondsPerRep,
      description,
      instructions,
      equipment,
      difficultyLevel,
      targetMuscleGroups,
      image,
      videoUrl,
      tags,
      language,
      translations,
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
  'secondsPerRep',
  'description',
  'instructions',
  'equipment',
  'difficultyLevel',
  'targetMuscleGroups',
  'image',
  'videoUrl',
  'tags',
  'language',
  'translations',
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
