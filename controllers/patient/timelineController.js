const { MilestoneTask, Milestone, Goal, CheckIn } = require('../../models');
const asyncHandler = require('../../utils/async-handler');
const ApiError = require('../../utils/api-error');
const { sendSuccess } = require('../../utils/api-response');
const { computeGoalStats } = require('../../utils/goalAdherence');
const { buildTimelinePayload, shapeGoal, getDayLogs } = require('../../utils/timelinePayload');
const { MEAL_LINKED_TASK_TITLES, WATER_TASK_TITLE } = require('../../utils/seedGoalTimeline');
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
 * @route   GET /api/patient/timeline/days/:date/logs
 * @desc    What this patient actually logged that day (meals + weight) -
 *          shown behind a milestone node on their own timeline
 * @access  Patient only
 */
exports.getMyDayLogs = asyncHandler(async (req, res) => {
  const { date } = req.params;
  const logs = await getDayLogs(req.user._id, date);
  if (!logs) throw ApiError.badRequest('Invalid date');
  return sendSuccess(res, { data: logs });
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
  // task by guessing/enumerating ids. Checked before the meal-linked guard
  // below so a wrong-patient request always 403s, regardless of task type.
  const goal = await Goal.findOne({ _id: milestone.goalId, patientId: req.user._id });
  if (!goal) throw ApiError.forbidden('Not your milestone');

  // Meal-linked tasks (Morning Drink...Night Drink) and Water Intake are
  // done automatically from the patient's real MealLog/WaterLog entries
  // (see utils/goalAdherence.js's computeTaskDoneMap) - a manual check-in
  // here would be a state that can never actually be read back as "done",
  // so reject it outright rather than silently no-op. Supplements has no
  // log source and stays manually checked off.
  if (MEAL_LINKED_TASK_TITLES.has(task.title) || task.title === WATER_TASK_TITLE) {
    throw ApiError.badRequest('This task is logged automatically');
  }

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
