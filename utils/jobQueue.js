/**
 * Minimal async job queue over the optional Redis client
 * (utils/redisClient.js) - cross-app performance optimization, Phase 3
 * (tasks 3.1 / 3.2 / 3.5).
 *
 * Why a Redis list and not BullMQ / a worker process: this API is a single
 * Vercel serverless function (api/index.js, maxDuration 180) with no
 * long-lived process to run a worker in. So the queue is a plain Redis list
 * that a Vercel Cron entry drains in bounded batches
 * (GET/POST /api/internal/cron/drain-jobs).
 *
 * Degradation: when REDIS_URL isn't configured the job is run inline,
 * best-effort, right where it was enqueued (same "feature still works, just
 * without the speedup" convention as utils/cache.js). So a dev box with no
 * Redis behaves exactly like today - the email send just happens on the
 * request path as before.
 *
 * Reliability model: at-least-once for the happy path, best-effort on a
 * mid-drain crash (a job LPOP'd but not yet completed when the function is
 * killed is lost - acceptable for "send an email", which today isn't
 * retried at all). Retries use a delayed ZSET so a transient failure is
 * re-attempted with backoff rather than hot-looped.
 */

const crypto = require('crypto');
const { client, isEnabled } = require('./redisClient');

const PENDING_KEY = 'jobs:pending';
const DELAYED_KEY = 'jobs:delayed'; // ZSET score = epoch ms when the job is ready
const FAILED_KEY = 'jobs:failed'; // list, capped - permanently-failed jobs for inspection / Sentry

const MAX_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 1000; // 1s, 2s, 4s
const FAILED_LIST_CAP = 200;
const DEFAULT_DRAIN_MAX = 25;

function makeJob(type, payload) {
  return {
    id: crypto.randomUUID(),
    type,
    payload,
    attempts: 0,
    enqueuedAt: Date.now(),
  };
}

/**
 * Lazily required to avoid a require cycle (jobHandlers -> emailService,
 * emailService -> jobQueue).
 */
function getRunJob() {
  // eslint-disable-next-line global-require
  return require('./jobHandlers').runJob;
}

/**
 * Enqueue a job. Returns `{ inline: true }` when it ran synchronously
 * (no Redis) or `{ id }` when it was queued. Never throws - a failed
 * inline run is logged, not propagated, so the caller's request still
 * succeeds (that's the whole point of moving the work off the request
 * path).
 * @param {string} type   handler key in utils/jobHandlers.js
 * @param {object} payload JSON-serializable
 * @param {{ delayMs?: number }} [opts]
 */
async function enqueue(type, payload, { delayMs = 0 } = {}) {
  const job = makeJob(type, payload);

  if (!isEnabled) {
    try {
      await getRunJob()(job);
    } catch (err) {
      console.error(`[jobQueue] inline "${type}" job failed (no Redis, not retried):`, err.message);
    }
    return { inline: true };
  }

  const raw = JSON.stringify(job);
  try {
    if (delayMs > 0) {
      await client.zadd(DELAYED_KEY, Date.now() + delayMs, raw);
    } else {
      await client.rpush(PENDING_KEY, raw);
    }
    return { id: job.id };
  } catch (err) {
    // Redis is configured but unreachable - fall back to an inline run so
    // the job isn't silently dropped.
    console.error(`[jobQueue] enqueue "${type}" failed, running inline:`, err.message);
    try {
      await getRunJob()(job);
    } catch (runErr) {
      console.error(`[jobQueue] inline fallback "${type}" also failed:`, runErr.message);
    }
    return { inline: true };
  }
}

/**
 * Move every delayed job whose ready-time has passed back onto the pending
 * list. Uses ZREM's return value as a claim so two overlapping drains
 * can't both promote the same job.
 */
async function promoteDueDelayedJobs(max) {
  const due = await client.zrangebyscore(DELAYED_KEY, '-inf', Date.now(), 'LIMIT', 0, max);
  let promoted = 0;
  for (const raw of due) {
    const claimed = await client.zrem(DELAYED_KEY, raw);
    if (claimed) {
      await client.rpush(PENDING_KEY, raw);
      promoted += 1;
    }
  }
  return promoted;
}

/**
 * Drain up to `max` jobs. Each job runs in its own try/catch so one bad
 * item never aborts the batch (task 3.5). On failure a job is re-queued
 * with exponential backoff until MAX_ATTEMPTS, then moved to the failed
 * list and reported to Sentry (task 3.2). Returns a summary for the cron
 * response.
 */
async function drainJobs({ max = DEFAULT_DRAIN_MAX } = {}) {
  if (!isEnabled) {
    return { skipped: 'redis-disabled', promoted: 0, processed: 0, succeeded: 0, retried: 0, failed: 0 };
  }

  const runJob = getRunJob();
  const promoted = await promoteDueDelayedJobs(max);

  let processed = 0;
  let succeeded = 0;
  let retried = 0;
  let failed = 0;

  for (let i = 0; i < max; i += 1) {
    let raw;
    try {
      raw = await client.lpop(PENDING_KEY);
    } catch (err) {
      console.error('[jobQueue] lpop failed, ending drain early:', err.message);
      break;
    }
    if (!raw) break;
    processed += 1;

    let job;
    try {
      job = JSON.parse(raw);
    } catch (err) {
      console.error('[jobQueue] dropping unparseable job:', err.message);
      continue;
    }

    job.attempts = (job.attempts || 0) + 1;

    try {
      await runJob(job);
      succeeded += 1;
    } catch (err) {
      job.lastError = err && err.message ? err.message : String(err);
      if (job.attempts < MAX_ATTEMPTS) {
        const backoff = BACKOFF_BASE_MS * 2 ** (job.attempts - 1);
        try {
          await client.zadd(DELAYED_KEY, Date.now() + backoff, JSON.stringify(job));
          retried += 1;
        } catch (zErr) {
          console.error('[jobQueue] failed to schedule retry, moving to failed set:', zErr.message);
          await pushFailed(job);
          failed += 1;
          reportFailure(job, err);
        }
      } else {
        job.failedAt = Date.now();
        await pushFailed(job);
        failed += 1;
        reportFailure(job, err);
      }
    }
  }

  return { promoted, processed, succeeded, retried, failed };
}

async function pushFailed(job) {
  try {
    await client.rpush(FAILED_KEY, JSON.stringify(job));
    await client.ltrim(FAILED_KEY, -FAILED_LIST_CAP, -1);
  } catch (err) {
    console.error('[jobQueue] could not record failed job:', err.message);
  }
}

function reportFailure(job, err) {
  console.error(
    `[jobQueue] job "${job.type}" (${job.id}) permanently failed after ${job.attempts} attempts:`,
    job.lastError
  );
  try {
    // eslint-disable-next-line global-require
    const Sentry = require('@sentry/node');
    Sentry.captureException(err instanceof Error ? err : new Error(job.lastError), {
      level: 'error',
      tags: { subsystem: 'jobQueue', jobType: job.type },
      extra: { jobId: job.id, attempts: job.attempts, payload: job.payload, enqueuedAt: job.enqueuedAt },
    });
  } catch (sentryErr) {
    console.error('[jobQueue] Sentry capture failed:', sentryErr.message);
  }
}

/** For the drain endpoint / ops: current queue depth. Best-effort. */
async function stats() {
  if (!isEnabled) return { enabled: false };
  try {
    const [pending, delayed, failed] = await Promise.all([
      client.llen(PENDING_KEY),
      client.zcard(DELAYED_KEY),
      client.llen(FAILED_KEY),
    ]);
    return { enabled: true, pending, delayed, failed };
  } catch (err) {
    return { enabled: true, error: err.message };
  }
}

module.exports = {
  enqueue,
  drainJobs,
  stats,
  MAX_ATTEMPTS,
  _keys: { PENDING_KEY, DELAYED_KEY, FAILED_KEY },
};
