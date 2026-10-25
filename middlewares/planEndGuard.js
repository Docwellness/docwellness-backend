/**
 * Refuses patient writes once the plan has ended (see utils/planEnd.js for
 * how the end day and the last allowed weigh-in date are decided).
 *
 * - requireLoggingOpen: meals, water, exercise, supplements, check-ins and
 *   grocery ticks. Gates on the write's own target date (body/query `date`,
 *   else today in IST), so an entry dated on the end day that is synced later
 *   from the app's offline queue is still accepted. On multipart routes it must
 *   sit after the multer middleware so the form `date` has been parsed.
 * - requireWeightWindowOpen: body log (weight, measurements, photos). Gates on
 *   the server's IST today: a multipart body is not parsed yet at this point
 *   and a server clock cannot be backdated by a client.
 *
 * Both fail open when the end day is unknown. Refusal is the same 403
 * envelope style as PLAN_PAUSED, and no patient values are logged.
 */

const fs = require('fs');
const {
  istDayKey,
  loadPlanEnd,
  isNonWeightLogClosed,
  isWeightClosed,
} = require('../utils/planEnd');

const LOGGING_CLOSED_MESSAGE = 'Your plan has ended. Request a new plan to keep logging.';
const WEIGHT_CLOSED_MESSAGE = 'Your plan has ended and the last weigh-in has passed.';

/** UTC calendar day of a request-supplied date, the way the controllers read it. */
function targetDayKey(req) {
  const raw = req.body?.date ?? req.query?.date;
  if (raw) {
    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  }
  return istDayKey(new Date());
}

function refuse(res, message, planEnd) {
  res.status(403).json({
    success: false,
    message,
    code: 'PLAN_ENDED',
    endDate: planEnd.endDay,
    weightLastDate: planEnd.lastWeighInDate,
  });
}

// Request ids already warned about in this process: one line per request is enough to make the gap visible.
const warnedRequestIds = new Set();

/** A paying patient with a plan but no expiry is a data gap: let the write through, but make it visible once. */
function warnIfExpiryMissing(planEnd) {
  if (planEnd.endDay || !planEnd.hasActivePlan) return;
  const requestId = String(planEnd.requestId);
  if (warnedRequestIds.has(requestId)) return;
  warnedRequestIds.add(requestId);
  console.warn(`planEndGuard: active-plan request ${requestId} has no subscriptionExpiresAt; write allowed`);
}

/** Multer writes an upload to disk before this guard can refuse; do not leave a refused file behind. */
function discardUpload(req) {
  const paths = [req.file, ...Object.values(req.files || {}).flat()].filter(Boolean).map((f) => f.path);
  paths.forEach((p) => fs.unlink(p, () => {}));
}

/**
 * Runs the check; a failed lookup fails open (same posture as a missing
 * expiry: locking a paying patient out is the worse failure) with an id-only warning.
 */
const guard = (isClosed) => async (req, res, next) => {
  let planEnd;
  try {
    planEnd = await loadPlanEnd(req.user._id);
  } catch {
    console.warn(`planEndGuard: plan end lookup failed for patient ${req.user._id}; write allowed`);
    return next();
  }
  warnIfExpiryMissing(planEnd);
  const closedMessage = isClosed(planEnd, req);
  if (closedMessage) {
    discardUpload(req);
    return refuse(res, closedMessage, planEnd);
  }
  return next();
};

const requireLoggingOpen = guard((planEnd, req) =>
  isNonWeightLogClosed(planEnd, targetDayKey(req)) ? LOGGING_CLOSED_MESSAGE : null
);

const requireWeightWindowOpen = guard((planEnd) =>
  isWeightClosed(planEnd, istDayKey(new Date())) ? WEIGHT_CLOSED_MESSAGE : null
);

module.exports = { requireLoggingOpen, requireWeightWindowOpen };
