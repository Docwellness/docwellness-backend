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
};

async function runJob(job) {
  const handler = HANDLERS[job.type];
  if (!handler) {
    throw new Error(`no handler registered for job type "${job.type}"`);
  }
  return handler(job);
}

module.exports = { runJob, HANDLERS };
