const { DietPlanRequest, Notification } = require('../../models');

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const REMINDER_WINDOW_DAYS = 3;

function formatDate(date) {
  return new Date(date).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

/**
 * Finds every DietPlanRequest whose subscriptionExpiresAt falls within the
 * next REMINDER_WINDOW_DAYS days and hasn't already been reminded for this
 * expiry (renewalReminderSentAt is stamped and reset on activation - see
 * activateDietPlan - so a renewed cycle gets a fresh reminder window), and
 * creates an in-app Notification for each.
 *
 * Deliberately DB-only: no push/socket emission here, so this stays safe to
 * run from a process with no socket server (the Vercel dev deployment has
 * none - see docs/cron-setup.md). Real-time delivery, where it happens at
 * all, comes from whichever client is already connected and reconnecting/
 * polling GET /notifications - this function only guarantees the record
 * exists.
 *
 * `now` is injectable so tests (and the endpoint itself, if ever needed) can
 * simulate a specific point in time without waiting for a real subscription
 * to approach expiry.
 */
async function runRenewalReminderSweep({ now = new Date() } = {}) {
  const windowEnd = new Date(now.getTime() + REMINDER_WINDOW_DAYS * MS_PER_DAY);

  const candidates = await DietPlanRequest.find({
    subscriptionExpiresAt: { $gte: now, $lte: windowEnd },
    renewalReminderSentAt: null,
    hasActivePlan: true,
  });

  let created = 0;
  for (const request of candidates) {
    await Notification.create({
      userId: request.patient,
      title: 'Your membership is expiring soon',
      message: `Your subscription expires on ${formatDate(request.subscriptionExpiresAt)}. Renew now to keep your diet plan active.`,
      type: 'membership_renewal',
      referenceId: request._id,
      referenceModel: 'DietPlanRequest',
    });
    request.renewalReminderSentAt = now;
    await request.save({ validateBeforeSave: false });
    created += 1;
  }

  return { checked: candidates.length, created };
}

module.exports = { runRenewalReminderSweep };
