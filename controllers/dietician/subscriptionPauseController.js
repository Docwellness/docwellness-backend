/**
 * Dietician-controlled subscription pause. A pause is a date window
 * [startDate, resumeDate) on the patient's active DietPlan.pauses[]. During
 * it the patient can't log and the Diet & Exercise tab is locked; once it
 * ends, plan content shifts forward by the window length (virtual calendar
 * shift - see utils/subscriptionPause.js). This controller additionally
 * extends the single scalar dates a pause should push out: the
 * subscription expiry, the active Goal's end (+ its still-future
 * milestones) and the active ExercisePlan's end.
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
} = require('../../models');
const {
  normDate,
  addDays,
  dayDiff,
  editablePause,
  normalizePauses,
} = require('../../utils/subscriptionPause');
const { logAuditEvent } = require('../../utils/auditLog');

const assertDieticianOwnsPatient = (dieticianId, patientId) =>
  DietPlanRequest.exists({ patient: patientId, dieticianId });

const bad = (res, message, code = 400) => res.status(code).json({ success: false, message });

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
 * milestones dated on/after `fromDate`, active ExercisePlan end.
 */
async function shiftSatelliteDates(patientId, dietPlan, fromDate, deltaDays) {
  if (deltaDays === 0) return;

  const request = dietPlan.request;
  if (request && request.subscriptionExpiresAt) {
    request.subscriptionExpiresAt = addDays(request.subscriptionExpiresAt, deltaDays);
    request.renewalReminderSentAt = null; // model requires nulling this whenever expiry moves
    await request.save();
    await User.updateOne(
      { _id: patientId },
      { $set: { 'status.subscriptionExpiresAt': request.subscriptionExpiresAt } }
    );
  }

  const goal = await Goal.findOne({ patientId, status: 'active' });
  if (goal) {
    if (goal.endDate) goal.endDate = addDays(goal.endDate, deltaDays);
    await goal.save();
    const deltaMs = deltaDays * 24 * 60 * 60 * 1000;
    await Milestone.updateMany({ goalId: goal._id, date: { $gte: normDate(fromDate) } }, [
      { $set: { date: { $add: ['$date', deltaMs] } } },
    ]);
  }

  const exercisePlan = await ExercisePlan.findOne({ patientId, status: 'Active' });
  if (exercisePlan && exercisePlan.endDate) {
    exercisePlan.endDate = addDays(exercisePlan.endDate, deltaDays);
    await exercisePlan.save();
  }
}

function pauseSummary(dietPlan) {
  const pauses = normalizePauses(dietPlan.pauses);
  const editable = editablePause(pauses);
  return {
    pauses: pauses.map((p) => ({
      startDate: p.startDate,
      resumeDate: p.resumeDate,
    })),
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

    const today = normDate(new Date());
    if (startDate < today) return bad(res, 'A pause cannot start in the past');

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

    dietPlan.pauses.push({ startDate, resumeDate });
    await dietPlan.save();

    const delta = dayDiff(startDate, resumeDate);
    await shiftSatelliteDates(patient._id, dietPlan, startDate, delta);

    logAuditEvent('subscription_paused', {
      dieticianId: String(req.user._id),
      patientId: String(patient._id),
      startDate: startDate.toISOString().slice(0, 10),
      resumeDate: resumeDate.toISOString().slice(0, 10),
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

    const pauses = normalizePauses(dietPlan.pauses);
    const editable = editablePause(pauses);
    if (!editable) return bad(res, 'No pause is scheduled or running to change', 404);

    // The editable window is always the last entry.
    const idx = dietPlan.pauses.length - 1;
    const current = dietPlan.pauses[idx];
    const today = normDate(new Date());
    const pauseHasStarted = normDate(current.startDate) <= today;

    let newStart = normDate(current.startDate);
    if (req.body?.startDate !== undefined) {
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

    current.startDate = newStart;
    current.resumeDate = newResume;
    await dietPlan.save();

    await shiftSatelliteDates(patient._id, dietPlan, newStart, newDelta - oldDelta);

    logAuditEvent('subscription_pause_updated', {
      dieticianId: String(req.user._id),
      patientId: String(patient._id),
      resumeDate: newResume.toISOString().slice(0, 10),
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

    const pauses = normalizePauses(dietPlan.pauses);
    const editable = editablePause(pauses);
    if (!editable) return bad(res, 'No pause is scheduled or running to cancel', 404);

    const idx = dietPlan.pauses.length - 1;
    const removed = dietPlan.pauses[idx];
    const delta = dayDiff(normDate(removed.startDate), normDate(removed.resumeDate));
    dietPlan.pauses.splice(idx, 1);
    await dietPlan.save();

    await shiftSatelliteDates(patient._id, dietPlan, normDate(removed.startDate), -delta);

    logAuditEvent('subscription_pause_cancelled', {
      dieticianId: String(req.user._id),
      patientId: String(patient._id),
    });

    res.status(200).json({ success: true, data: pauseSummary(dietPlan) });
  } catch (error) {
    next(error);
  }
};
