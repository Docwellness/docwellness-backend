/**
 * Dietician-controlled subscription pause. A pause is a date window
 * [startDate, resumeDate) on the patient's active DietPlan.pauses[]. During
 * it the patient can't log and the Diet & Exercise tab is locked; once it
 * ends, plan content shifts forward by the window length (virtual calendar
 * shift - see utils/subscriptionPause.js). This controller additionally
 * extends the single scalar dates a pause should push out: the
 * subscription expiry, the active Goal's end (+ its still-future
 * milestones) and the active ExercisePlan's end, and notifies the patient.
 *
 *   POST   /api/dietician/patients/:patientId/subscription/pause   { startDate, resumeDate }
 *   PATCH  /api/dietician/patients/:patientId/subscription/pause   { startDate?, resumeDate }
 *   DELETE /api/dietician/patients/:patientId/subscription/pause
 */

const mongoose = require('mongoose');
const {
  User,
  DietPlan,
  DietPlanRequest,
  ExercisePlan,
  Goal,
  Milestone,
  Notification,
} = require('../../models');
const {
  normDate,
  addDays,
  dayDiff,
  editablePause,
  normalizePauses,
} = require('../../utils/subscriptionPause');
const { logAuditEvent } = require('../../utils/auditLog');
const { sendPushToTokens } = require('../../utils/push');
const { getChatIO } = require('../../chat');

const assertDieticianOwnsPatient = (dieticianId, patientId) =>
  DietPlanRequest.exists({ patient: patientId, dieticianId });

const bad = (res, message, code = 400) => res.status(code).json({ success: false, message });
const ymd = (d) => normDate(d).toISOString().slice(0, 10);

async function loadContext(req, res) {
  const { patientId } = req.params;
  if (!mongoose.Types.ObjectId.isValid(patientId)) {
    bad(res, 'Invalid patient id');
    return null;
  }
  const patient = await User.findById(patientId);
  if (!patient || patient.role !== 'patient') {
    bad(res, 'Patient not found', 404);
    return null;
  }
  if (!(await assertDieticianOwnsPatient(req.user._id, patient._id))) {
    bad(res, 'You are not authorized to access this patient', 403);
    return null;
  }
  const dietPlan = await DietPlan.findOne({ patientId, status: 'Active' })
    .sort({ cycleNumber: 1 })
    .populate('request');
  if (!dietPlan) {
    bad(res, 'This patient has no active diet plan to pause', 409);
    return null;
  }
  return { patient, dietPlan };
}

/**
 * Push the pause's "satellite" dates by `deltaDays` (negative to undo):
 * subscription expiry (+ its User.status mirror), active Goal end + its
 * milestones dated on/after `fromDate`, active ExercisePlan end. Each
 * section is best-effort - a failure logs and is swallowed so it can never
 * leave the pause itself half-applied.
 */
async function shiftSatelliteDates(patientId, dietPlan, fromDate, deltaDays) {
  if (deltaDays === 0) return;
  const from = normDate(fromDate);

  try {
    const request = dietPlan.request;
    if (request && request.subscriptionExpiresAt) {
      request.subscriptionExpiresAt = addDays(request.subscriptionExpiresAt, deltaDays);
      request.renewalReminderSentAt = null;
      await request.save();
      await User.updateOne(
        { _id: patientId },
        { $set: { 'status.subscriptionExpiresAt': request.subscriptionExpiresAt } }
      );
    }
  } catch (err) {
    console.error('[subscriptionPause] subscription expiry shift failed:', err.message);
  }

  try {
    const goal = await Goal.findOne({ patientId, status: 'active' });
    if (goal) {
      if (goal.endDate) goal.endDate = addDays(goal.endDate, deltaDays);
      await goal.save();
      const milestones = await Milestone.find({ goalId: goal._id, date: { $gte: from } })
        .select('_id date')
        .lean();
      if (milestones.length) {
        await Milestone.bulkWrite(
          milestones.map((m) => ({
            updateOne: {
              filter: { _id: m._id },
              update: { $set: { date: addDays(m.date, deltaDays) } },
            },
          }))
        );
      }
    }
  } catch (err) {
    console.error('[subscriptionPause] goal/milestone shift failed:', err.message);
  }

  try {
    const exercisePlan = await ExercisePlan.findOne({ patientId, status: 'Active' });
    if (exercisePlan && exercisePlan.endDate) {
      exercisePlan.endDate = addDays(exercisePlan.endDate, deltaDays);
      await exercisePlan.save();
    }
  } catch (err) {
    console.error('[subscriptionPause] exercise plan shift failed:', err.message);
  }
}

/** In-app Notification + live socket event (drives the patient app's Home
 * refresh - see SocketService's 'notification.new' listener) + best-effort
 * push. Never throws. */
async function notifyPatient(patientId, { title, message }) {
  let notif = null;
  try {
    notif = await Notification.create({
      userId: patientId,
      title,
      message,
      type: 'subscription_pause',
    });
  } catch (err) {
    console.error('[subscriptionPause] Notification.create failed:', err.message);
  }
  try {
    const io = getChatIO();
    if (io) {
      io.to(`user:${patientId}`).emit('notification.new', {
        id: notif?._id,
        title,
        message,
        type: 'subscription_pause',
        createdAt: notif?.createdAt || new Date(),
      });
    }
  } catch (err) {
    console.error('[subscriptionPause] socket emit failed:', err.message);
  }
  try {
    const patient = await User.findById(patientId).select('deviceTokens').lean();
    const tokens = (patient?.deviceTokens || []).map((t) => t.token);
    await sendPushToTokens(
      tokens,
      { title, body: message, data: { type: 'subscription_pause' } },
      (dead) =>
        User.updateOne({ _id: patientId }, { $pull: { deviceTokens: { token: dead } } }).catch(
          () => {}
        )
    );
  } catch (err) {
    console.error('[subscriptionPause] push failed:', err.message);
  }
}

function pauseSummary(dietPlan) {
  const pauses = normalizePauses(dietPlan.pauses);
  const editable = editablePause(pauses);
  return {
    pauses: pauses.map((p) => ({ startDate: p.startDate, resumeDate: p.resumeDate })),
    active: editable
      ? { startDate: editable.startDate, resumeDate: editable.resumeDate }
      : null,
    subscriptionExpiresAt: dietPlan.request?.subscriptionExpiresAt || null,
  };
}

exports.pauseSubscription = async (req, res, next) => {
  try {
    const ctx = await loadContext(req, res);
    if (!ctx) return;
    const { patient, dietPlan } = ctx;

    const startDate = normDate(req.body?.startDate);
    const resumeDate = normDate(req.body?.resumeDate);
    if (!startDate || !resumeDate) return bad(res, 'startDate and resumeDate are required');
    if (resumeDate <= startDate) return bad(res, 'resumeDate must be after startDate');
    if (startDate < normDate(new Date())) return bad(res, 'A pause cannot start in the past');

    const existing = normalizePauses(dietPlan.pauses);
    if (editablePause(existing)) {
      return bad(
        res,
        'This plan already has a pause scheduled or running - edit or cancel it first',
        409
      );
    }
    if (existing.length && startDate < existing[existing.length - 1].resumeDate) {
      return bad(res, 'A new pause must start after the previous one ends');
    }

    const delta = dayDiff(startDate, resumeDate);
    // Satellites first so a failure there never leaves pauses[] half-set.
    await shiftSatelliteDates(patient._id, dietPlan, startDate, delta);
    dietPlan.pauses.push({ startDate, resumeDate });
    await dietPlan.save();

    logAuditEvent('subscription_paused', {
      dieticianId: String(req.user._id),
      patientId: String(patient._id),
      startDate: ymd(startDate),
      resumeDate: ymd(resumeDate),
    });
    await notifyPatient(patient._id, {
      title: 'Your plan is paused',
      message: `Your dietician has paused your plan from ${ymd(startDate)}. It resumes on ${ymd(resumeDate)} and picks up right where it left off.`,
    });

    res.status(200).json({ success: true, data: pauseSummary(dietPlan) });
  } catch (error) {
    next(error);
  }
};

exports.updatePause = async (req, res, next) => {
  try {
    const ctx = await loadContext(req, res);
    if (!ctx) return;
    const { patient, dietPlan } = ctx;

    const editable = editablePause(normalizePauses(dietPlan.pauses));
    if (!editable) return bad(res, 'No pause is scheduled or running to change', 404);

    const idx = dietPlan.pauses.length - 1;
    const current = dietPlan.pauses[idx];
    const today = normDate(new Date());
    const pauseHasStarted = normDate(current.startDate) <= today;

    let newStart = normDate(current.startDate);
    if (req.body?.startDate !== undefined && req.body?.startDate !== null) {
      if (pauseHasStarted) return bad(res, "The pause has already started - its start date can't change");
      const s = normDate(req.body.startDate);
      if (!s) return bad(res, 'Invalid startDate');
      if (s < today) return bad(res, 'A pause cannot start in the past');
      newStart = s;
    }

    const newResume = normDate(req.body?.resumeDate);
    if (!newResume) return bad(res, 'resumeDate is required');
    if (newResume <= newStart) return bad(res, 'resumeDate must be after startDate');
    if (newResume <= today) return bad(res, 'resumeDate must be in the future');

    const oldDelta = dayDiff(normDate(current.startDate), normDate(current.resumeDate));
    const newDelta = dayDiff(newStart, newResume);

    await shiftSatelliteDates(patient._id, dietPlan, newStart, newDelta - oldDelta);
    current.startDate = newStart;
    current.resumeDate = newResume;
    await dietPlan.save();

    logAuditEvent('subscription_pause_updated', {
      dieticianId: String(req.user._id),
      patientId: String(patient._id),
      resumeDate: ymd(newResume),
    });
    await notifyPatient(patient._id, {
      title: 'Pause dates updated',
      message: `Your plan now resumes on ${ymd(newResume)}.`,
    });

    res.status(200).json({ success: true, data: pauseSummary(dietPlan) });
  } catch (error) {
    next(error);
  }
};

exports.cancelPause = async (req, res, next) => {
  try {
    const ctx = await loadContext(req, res);
    if (!ctx) return;
    const { patient, dietPlan } = ctx;

    const editable = editablePause(normalizePauses(dietPlan.pauses));
    if (!editable) return bad(res, 'No pause is scheduled or running to cancel', 404);

    const idx = dietPlan.pauses.length - 1;
    const removed = dietPlan.pauses[idx];
    const delta = dayDiff(normDate(removed.startDate), normDate(removed.resumeDate));

    await shiftSatelliteDates(patient._id, dietPlan, normDate(removed.startDate), -delta);
    dietPlan.pauses.splice(idx, 1);
    await dietPlan.save();

    logAuditEvent('subscription_pause_cancelled', {
      dieticianId: String(req.user._id),
      patientId: String(patient._id),
    });
    await notifyPatient(patient._id, {
      title: 'Pause cancelled',
      message: 'Your dietician has cancelled the pause. Your plan continues as normal.',
    });

    res.status(200).json({ success: true, data: pauseSummary(dietPlan) });
  } catch (error) {
    next(error);
  }
};
