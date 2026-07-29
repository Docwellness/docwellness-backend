const { Goal, Milestone, MilestoneTask, Nudge, Notification, User } = require('../../models');
const asyncHandler = require('../../utils/async-handler');
const ApiError = require('../../utils/api-error');
const { sendSuccess } = require('../../utils/api-response');
const { buildTimelinePayload, getDayLogs } = require('../../utils/timelinePayload');
const { getChatIO } = require('../../chat');
const { sendPushToTokens } = require('../../utils/push');

/**
 * Confirms this patient's active Goal belongs to the requesting dietician,
 * matching activateDietPlan's own `{_id: dietPlanId, patientId, dieticianId}`
 * ownership-check pattern. Throws (404, not 403) so an unassigned dietician
 * can't distinguish "not your patient" from "patient doesn't exist" by
 * response shape.
 */
async function assertAssignedGoal(patientId, dieticianId) {
  const goal = await Goal.findOne({ patientId, dieticianId, status: 'active' });
  if (!goal) throw ApiError.notFound('No active goal for this patient');
  return goal;
}

/**
 * @route   GET /api/dietician/patients/:patientId/timeline?from=-30&to=30
 * @desc    Adherence-heat line for a specific patient
 * @access  Dietician only (must be this patient's assigned dietician)
 */
exports.getPatientTimeline = asyncHandler(async (req, res) => {
  const { patientId } = req.params;
  await assertAssignedGoal(patientId, req.user._id);

  const payload = await buildTimelinePayload(patientId, {
    from: req.query.from,
    to: req.query.to,
  });
  return sendSuccess(res, { data: payload });
});

/**
 * @route   GET /api/dietician/patients/:patientId/days/:date/logs
 * @desc    What the patient actually logged that day (meals + weight) -
 *          reads existing MealLog/Progress, no new storage
 * @access  Dietician only
 */
exports.getDayLogs = asyncHandler(async (req, res) => {
  const { patientId, date } = req.params;
  await assertAssignedGoal(patientId, req.user._id);

  const logs = await getDayLogs(patientId, date);
  if (!logs) throw ApiError.badRequest('Invalid date');

  return sendSuccess(res, { data: logs });
});

/**
 * @route   POST /api/dietician/nudges
 * @desc    Create an in-app Notification for the patient, plus best-effort
 *          live socket delivery and a real OS push (each independently
 *          best-effort - a failure in either must never fail this request
 *          or block the in-app Notification from being created).
 * @access  Dietician only
 */
exports.createNudge = asyncHandler(async (req, res) => {
  const { userId, milestoneId, message } = req.body || {};
  if (!userId || !message) throw ApiError.badRequest('userId and message are required');

  await assertAssignedGoal(userId, req.user._id);

  const nudge = await Nudge.create({
    dieticianId: req.user._id,
    patientId: userId,
    milestoneId: milestoneId || undefined,
    message,
  });

  const notification = await Notification.create({
    userId,
    title: 'Message from your dietician',
    message,
    type: 'milestone',
    referenceId: milestoneId || undefined,
    referenceModel: milestoneId ? 'Milestone' : undefined,
  });

  const [dietician, patient] = await Promise.all([
    User.findById(req.user._id).select('profile.fullName').lean(),
    User.findById(userId).select('deviceTokens').lean(),
  ]);

  const ioRef = getChatIO();
  if (ioRef) {
    ioRef.to(`user:${userId}`).emit('nudge:received', {
      message,
      milestoneId: milestoneId || null,
      dieticianName: dietician?.profile?.fullName || 'Your dietician',
      sentAt: nudge.sentAt,
    });
  }

  const tokens = (patient?.deviceTokens || []).map((t) => t.token);
  sendPushToTokens(
    tokens,
    {
      title: 'Message from your dietician',
      body: message,
      data: { deepLink: `docwellness://timeline?focus=${milestoneId || ''}` },
    },
    (deadToken) => {
      User.updateOne({ _id: userId }, { $pull: { deviceTokens: { token: deadToken } } }).catch(() => {});
    }
  ).catch((err) => console.error('[createNudge] push failed (non-fatal):', err.message));

  return sendSuccess(res, {
    statusCode: 201,
    data: { ok: true, nudgeId: nudge._id, notificationId: notification._id },
  });
});

/**
 * @route   POST /api/dietician/milestones
 * @desc    Add a custom milestone (with optional tasks) for a patient's goal
 * @access  Dietician only
 */
exports.createMilestone = asyncHandler(async (req, res) => {
  const { userId, type, date, title, subtitle, targetMetric, tasks } = req.body || {};
  if (!userId || !type || !date || !title) {
    throw ApiError.badRequest('userId, type, date, and title are required');
  }

  const goal = await assertAssignedGoal(userId, req.user._id);

  const lastSort = await Milestone.findOne({ goalId: goal._id }).sort({ sortOrder: -1 }).select('sortOrder');
  const milestone = await Milestone.create({
    goalId: goal._id,
    type,
    title,
    subtitle,
    date: new Date(date),
    sortOrder: (lastSort?.sortOrder ?? 0) + 1,
    targetMetric,
    createdBy: req.user._id,
  });

  if (Array.isArray(tasks) && tasks.length > 0) {
    await MilestoneTask.insertMany(
      tasks.map((t, index) => ({
        milestoneId: milestone._id,
        title: t.title,
        metric: t.metric,
        icon: t.icon,
        sortOrder: index,
      }))
    );
  }

  const ioRef = getChatIO();
  if (ioRef) {
    ioRef.to(`user:${userId}`).emit('milestone:added', { milestone });
  }

  return sendSuccess(res, { statusCode: 201, data: { milestone } });
});

/**
 * @route   PUT /api/dietician/milestones/:id
 * @desc    Edit an existing milestone's targets/tasks
 * @access  Dietician only
 */
exports.updateMilestone = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { title, subtitle, targetMetric, date } = req.body || {};

  const milestone = await Milestone.findById(id);
  if (!milestone) throw ApiError.notFound('Milestone not found');

  const goal = await Goal.findOne({ _id: milestone.goalId, dieticianId: req.user._id });
  if (!goal) throw ApiError.forbidden('Not your patient');

  if (title !== undefined) milestone.title = title;
  if (subtitle !== undefined) milestone.subtitle = subtitle;
  if (targetMetric !== undefined) milestone.targetMetric = targetMetric;
  if (date !== undefined) milestone.date = new Date(date);
  await milestone.save();

  return sendSuccess(res, { data: { milestone } });
});
