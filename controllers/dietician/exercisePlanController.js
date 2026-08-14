// Dietician-side exercise plan assignment. Deliberately simpler than
// dietPlanController.js's multi-doc AI-generation/finalize lifecycle -
// there's one evergreen ExercisePlan doc per patient, upserted in place by
// the dietician picking from the Exercise catalog (see
// select_exercise_sheet.dart), not regenerated per week. See the Exercise
// Plan feature plan's "Architecture decisions" for why.

const mongoose = require('mongoose');
const { ExercisePlan, Exercise } = require('../../models');
const { DAY_GROUPS } = require('../../utils/dayGroups');

function validateDailyExercises(dailyExercises) {
  if (!Array.isArray(dailyExercises)) {
    return 'dailyExercises must be an array';
  }
  for (const entry of dailyExercises) {
    if (!mongoose.Types.ObjectId.isValid(entry?.exerciseId)) {
      return 'Each entry needs a valid exerciseId';
    }
    // durationMinutes is optional (see ExercisePlan.js's own comment - it's
    // per-set when sets is also given, else a flat total) - only validated
    // when actually provided, same as sets/reps below.
    if (entry?.durationMinutes != null && (typeof entry.durationMinutes !== 'number' || entry.durationMinutes <= 0)) {
      return 'durationMinutes must be a positive number when provided';
    }
    if (!DAY_GROUPS.includes(entry?.dayGroup)) {
      return `Each entry needs a dayGroup from: ${DAY_GROUPS.join(', ')}`;
    }
  }
  return null;
}

/**
 * @route   POST /api/dietician/patients/:patientId/exercise-plans
 * @desc    Create or update (upsert) the patient's one evergreen exercise
 *          plan - the dietician submits the full dailyExercises array each
 *          time (same "latest selection wins" model as the diet plan's
 *          overwrite-or-append, just for the whole list at once here since
 *          there's no per-servingTime granularity to preserve).
 * @access  Private (Dietician)
 */
exports.upsertExercisePlan = async (req, res, next) => {
  try {
    const dieticianId = req.user._id;
    const { patientId } = req.params;
    const { dailyExercises } = req.body || {};

    if (!mongoose.Types.ObjectId.isValid(patientId)) {
      return res.status(400).json({ success: false, message: 'Invalid patient id' });
    }

    const validationError = validateDailyExercises(dailyExercises);
    if (validationError) {
      return res.status(400).json({ success: false, message: validationError });
    }

    // Every referenced exercise must actually belong to this dietician's
    // own catalog - same tenant-isolation guarantee Recipe lookups get
    // elsewhere in this codebase.
    const exerciseIds = [...new Set(dailyExercises.map((e) => e.exerciseId))];
    const ownedCount = await Exercise.countDocuments({
      _id: { $in: exerciseIds },
      dieticianId,
    });
    if (ownedCount !== exerciseIds.length) {
      return res.status(400).json({
        success: false,
        message: 'One or more exercises were not found in your catalog',
      });
    }

    let plan = await ExercisePlan.findOne({ patientId, dieticianId, status: { $ne: 'Completed' } });
    if (!plan) {
      plan = new ExercisePlan({ patientId, dieticianId, status: 'Draft' });
    }
    plan.dailyExercises = dailyExercises;
    await plan.save();

    return res.status(200).json({
      success: true,
      data: plan,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @route   GET /api/dietician/patients/:patientId/exercise-plans/current
 * @desc    Fetches the patient's one evergreen plan directly by patientId -
 *          same lookup upsertExercisePlan itself uses - so the app never
 *          needs to remember a plan's _id just to display what's already
 *          assigned. Returns { data: null } (not a 404) when nothing has
 *          been created yet, since that's a normal state, not an error.
 * @access  Private (Dietician)
 */
exports.getCurrentExercisePlan = async (req, res, next) => {
  try {
    const dieticianId = req.user._id;
    const { patientId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(patientId)) {
      return res.status(400).json({ success: false, message: 'Invalid patient id' });
    }

    const plan = await ExercisePlan.findOne({
      patientId,
      dieticianId,
      status: { $ne: 'Completed' },
    })
      .populate('dailyExercises.exerciseId')
      .lean();

    return res.status(200).json({ success: true, data: plan || null });
  } catch (error) {
    next(error);
  }
};

/**
 * @route   GET /api/dietician/patients/:patientId/exercise-plans/:exercisePlanId/details
 * @access  Private (Dietician)
 */
exports.getExercisePlanDetails = async (req, res, next) => {
  try {
    const dieticianId = req.user._id;
    const { patientId, exercisePlanId } = req.params;

    if (
      !mongoose.Types.ObjectId.isValid(patientId) ||
      !mongoose.Types.ObjectId.isValid(exercisePlanId)
    ) {
      return res.status(400).json({ success: false, message: 'Invalid patient or exercise plan id' });
    }

    const plan = await ExercisePlan.findOne({
      _id: exercisePlanId,
      patientId,
      dieticianId,
    })
      .populate('dailyExercises.exerciseId')
      .lean();

    if (!plan) {
      return res.status(404).json({ success: false, message: 'Exercise plan not found for this patient' });
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
 * @route   POST /api/dietician/patients/:patientId/exercise-plans/:exercisePlanId/activate
 * @desc    Draft -> Active. Deactivates any other Active plan for this
 *          patient first, mirroring the "one Active DietPlan per patient"
 *          invariant used elsewhere (see seedGoalTimeline.js's
 *          Goal.findOne({patientId, status:'active'}) reasoning).
 * @access  Private (Dietician)
 */
exports.activateExercisePlan = async (req, res, next) => {
  try {
    const dieticianId = req.user._id;
    const { patientId, exercisePlanId } = req.params;

    if (
      !mongoose.Types.ObjectId.isValid(patientId) ||
      !mongoose.Types.ObjectId.isValid(exercisePlanId)
    ) {
      return res.status(400).json({ success: false, message: 'Invalid patient or exercise plan id' });
    }

    const plan = await ExercisePlan.findOne({ _id: exercisePlanId, patientId, dieticianId });
    if (!plan) {
      return res.status(404).json({ success: false, message: 'Exercise plan not found for this patient' });
    }

    await ExercisePlan.updateMany(
      { patientId, status: 'Active', _id: { $ne: plan._id } },
      { $set: { status: 'Completed' } }
    );

    plan.status = 'Active';
    await plan.save();

    return res.status(200).json({
      success: true,
      data: plan,
    });
  } catch (error) {
    next(error);
  }
};
