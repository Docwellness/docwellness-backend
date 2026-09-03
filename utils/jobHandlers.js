/**
 * Job type -> handler map for utils/jobQueue.js (Phase 3, task 3.1).
 *
 * A handler receives the whole job (`{ id, type, payload, attempts, ... }`)
 * and must either resolve (success) or reject (the queue retries with
 * backoff, then moves it to the failed set). Handlers must be idempotent
 * enough that a retry after a partial success is harmless - for email that
 * just means a duplicate send in the rare retry-after-timeout case, which
 * is acceptable.
 */

const HANDLERS = {
  /**
   * payload: a fully-rendered email spec `{ to, subject, text, html, from }`
   * (the same shape utils/emailService.sendEmail takes). Templates are
   * rendered at enqueue time so no template registry / arg-versioning is
   * needed here.
   */
  async email(job) {
    // eslint-disable-next-line global-require
    const { sendEmail } = require('./emailService');
    await sendEmail(job.payload);
  },

  /**
   * payload: `{ patientId, tokens: string[], notification: { title, body, data } }`.
   * One job per recipient (sendPushToTokens already multicasts across that
   * user's tokens in a single FCM call). sendPushToTokens is itself
   * best-effort and never throws, so a push job effectively always
   * "succeeds" from the queue's point of view - individual dead tokens are
   * pruned from the user doc via the onInvalidToken callback, not retried.
   * That's deliberate: a stale FCM token is a permanent failure, and the
   * value here is getting the send off the cron sweep's critical path, not
   * requeuing pushes.
   */
  async push(job) {
    // eslint-disable-next-line global-require
    const { sendPushToTokens } = require('./push');
    // eslint-disable-next-line global-require
    const { User } = require('../models');
    const { patientId, tokens, notification } = job.payload || {};
    await sendPushToTokens(tokens, notification, (deadToken) => {
      if (!patientId) return;
      User.updateOne(
        { _id: patientId },
        { $pull: { deviceTokens: { token: deadToken } } }
      ).catch(() => {});
    });
  },
};

async function runJob(job) {
  const handler = HANDLERS[job.type];
  if (!handler) {
    throw new Error(`no handler registered for job type "${job.type}"`);
  }
  return handler(job);
}

module.exports = { runJob, HANDLERS };
