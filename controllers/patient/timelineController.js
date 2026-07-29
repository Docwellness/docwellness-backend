const { MilestoneTask, Milestone, Goal, CheckIn } = require('../../models');
const asyncHandler = require('../../utils/async-handler');
const ApiError = require('../../utils/api-error');
const { sendSuccess } = require('../../utils/api-response');
const { computeGoalStats } = require('../../utils/goalAdherence');
const { buildTimelinePayload, shapeGoal } = require('../../utils/timelinePayload');
const { getChatIO } = require('../../chat');

/**
 * @route   GET /api/patient/timeline?from=-14&to=30
 * @desc    Full goal + stats + windowed milestone/task list for this patient
 * @access  Patient only
 */
exports.getTimeline = asyncHandler(async (req, res) => {
  const payload = await buildTimelinePayload(req.user._id, {
    from: req.query.from,
    to: req.query.to,
  });
  return sendSuccess(res, { data: payload });
});

/**
 * @route   GET /api/patient/timeline/summary
 * @desc    Header stats only (goal + stats, no milestone list) - light
 *          enough to poll after a check-in without refetching the full line
 * @access  Patient only
 */
exports.getTimelineSummary = asyncHandler(async (req, res) => {
  const { goal, stats } = await computeGoalStats(req.user._id);
  return sendSuccess(res, { data: { goal: goal ? shapeGoal(goal) : null, stats } });
});

/**
 * @route   POST /api/patient/check-ins
 * @desc    Mark a task done for today
 * @access  Patient only
 */
exports.createCheckIn = asyncHandler(async (req, res) => {
  const { taskId, milestoneId, value } = req.body || {};
  if (!taskId || !milestoneId) {
    throw ApiError.badRequest('taskId and milestoneId are required');
  }

  const task = await MilestoneTask.findOne({ _id: taskId, milestoneId });
  if (!task) throw ApiError.notFound('Task not found');

  const milestone = await Milestone.findById(milestoneId);
  if (!milestone) throw ApiError.notFound('Milestone not found');

  // Ownership check: the milestone's goal must belong to this patient -
  // otherwise any authenticated patient could check off another patient's
  // task by guessing/enumerating ids.
  const goal = await Goal.findOne({ _id: milestone.goalId, patientId: req.user._id });
  if (!goal) throw ApiError.forbidden('Not your milestone');

  const todayKey = new Date().toISOString().slice(0, 10);

  let checkIn;
  try {
    checkIn = await CheckIn.create({
      patientId: req.user._id,
      taskId,
      milestoneId,
      value: value ?? undefined,
    });
  } catch (error) {
    // Duplicate check-in for the same task today (unique index on
    // {taskId, patientId, dateKey}) - treat as success, not a conflict;
    // the patient's intent (task done today) is already satisfied.
    if (error.code === 11000) {
      checkIn = await CheckIn.findOne({ taskId, patientId: req.user._id, dateKey: todayKey });
    } else {
      throw error;
    }
  }

  const { stats } = await computeGoalStats(req.user._id);

  // Best-effort live updates - never block or fail the response on these.
  // See docs precedent: controllers/dietician/firstConsultationController.js
  // uses the exact same getChatIO()-guarded emit pattern.
  const ioRef = getChatIO();
  if (ioRef) {
    ioRef.to(`user:${req.user._id}`).emit('timeline:updated', {
      milestoneId,
      goalStreak: stats?.streak ?? 0,
    });
    if (goal.dieticianId) {
      const riskLevel =
        (stats?.adherence30d ?? 0) >= 0.8 ? 'green' : (stats?.adherence30d ?? 0) >= 0.5 ? 'amber' : 'red';
      ioRef.to(`user:${goal.dieticianId}`).emit('patient:adherence_changed', {
        patientId: req.user._id,
        adherence7d: stats && stats.weekTotal > 0 ? stats.weekDone / stats.weekTotal : 0,
        goalStreak: stats?.streak ?? 0,
        riskLevel,
      });
    }
  }

  return sendSuccess(res, {
    statusCode: 201,
    data: { checkIn, goalStreak: stats?.streak ?? 0 },
  });
});

/**
 * @route   DELETE /api/patient/check-ins/today/:taskId
 * @desc    Uncheck a task for today
 * @access  Patient only
 */
exports.deleteTodayCheckIn = asyncHandler(async (req, res) => {
  const { taskId } = req.params;
  const todayKey = new Date().toISOString().slice(0, 10);

  await CheckIn.deleteOne({ taskId, patientId: req.user._id, dateKey: todayKey });

  return sendSuccess(res, { data: { ok: true } });
});
