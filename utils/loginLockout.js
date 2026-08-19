/**
 * Redis-backed login lockout (AI_EXECUTION_PLAN.md Phase 9, P9-B2). Locks
 * an email+role pair out of login after too many failed attempts within a
 * rolling window, for a random duration - a fixed lock length lets an
 * attacker just wait it out on a timer; randomizing it (crypto.randomInt,
 * not Math.random - this gates account access, not a cosmetic delay) makes
 * that not worth automating.
 *
 * Follows the same optional-Redis convention as utils/redisClient.js /
 * middlewares/rateLimiters.js: never hard-fails when REDIS_URL isn't
 * configured. The in-process Map fallback below is best-effort only - it's
 * per-instance and resets on restart/deploy, so it doesn't meaningfully
 * protect a multi-instance or serverless deployment (Vercel dev-api). Set
 * REDIS_URL in any environment where this lockout actually needs to hold.
 */

const crypto = require('crypto');
const { client: redis, isEnabled: redisEnabled } = require('./redisClient');

const THRESHOLDS = {
  patient: { maxAttempts: 5, windowSeconds: 15 * 60 },
  dietician: { maxAttempts: 3, windowSeconds: 10 * 60 },
};

const LOCK_MIN_SECONDS = 60;
const LOCK_MAX_SECONDS = 300;

// In-process fallback store - see doc comment above for its limitations.
const memoryAttempts = new Map(); // key -> { count, expiresAt }
const memoryLocks = new Map(); // key -> lockedUntilMs

function thresholdFor(role) {
  return THRESHOLDS[role] || THRESHOLDS.patient;
}

function attemptKey(role, email) {
  return `login_attempts:${role}:${email}`;
}

function lockKey(role, email) {
  return `login_lock:${role}:${email}`;
}

function getRandomLockSeconds() {
  return crypto.randomInt(LOCK_MIN_SECONDS, LOCK_MAX_SECONDS + 1);
}

/**
 * Checks whether `role`+`email` is currently locked out. Returns
 * `{ locked: false, retryAfter: 0 }` when not locked, or
 * `{ locked: true, retryAfter: <seconds> }` when it is.
 */
async function isLoginLocked(role, email) {
  const key = lockKey(role, email);

  if (redisEnabled) {
    const lockedUntil = await redis.get(key);
    if (!lockedUntil) return { locked: false, retryAfter: 0 };
    const retryAfter = Math.ceil((Number(lockedUntil) - Date.now()) / 1000);
    if (retryAfter <= 0) {
      await redis.del(key);
      return { locked: false, retryAfter: 0 };
    }
    return { locked: true, retryAfter };
  }

  const lockedUntilMs = memoryLocks.get(key);
  if (!lockedUntilMs) return { locked: false, retryAfter: 0 };
  const retryAfter = Math.ceil((lockedUntilMs - Date.now()) / 1000);
  if (retryAfter <= 0) {
    memoryLocks.delete(key);
    return { locked: false, retryAfter: 0 };
  }
  return { locked: true, retryAfter };
}

/**
 * Records a failed login attempt. Returns `{ locked: true, retryAfter }`
 * when this attempt tripped the threshold and a lock was just set,
 * otherwise `{ locked: false, retryAfter: 0 }`.
 */
async function registerFailedLogin(role, email) {
  const { maxAttempts, windowSeconds } = thresholdFor(role);
  const aKey = attemptKey(role, email);
  const lKey = lockKey(role, email);

  let attempts;
  if (redisEnabled) {
    attempts = await redis.incr(aKey);
    if (attempts === 1) {
      await redis.expire(aKey, windowSeconds);
    }
  } else {
    const now = Date.now();
    const entry = memoryAttempts.get(aKey);
    if (!entry || entry.expiresAt < now) {
      attempts = 1;
      memoryAttempts.set(aKey, { count: 1, expiresAt: now + windowSeconds * 1000 });
    } else {
      entry.count += 1;
      attempts = entry.count;
    }
  }

  if (attempts >= maxAttempts) {
    const lockSeconds = getRandomLockSeconds();
    const lockedUntilMs = Date.now() + lockSeconds * 1000;

    if (redisEnabled) {
      await redis.set(lKey, String(lockedUntilMs), 'PX', lockSeconds * 1000);
      await redis.del(aKey);
    } else {
      memoryLocks.set(lKey, lockedUntilMs);
      memoryAttempts.delete(aKey);
    }

    return { locked: true, retryAfter: lockSeconds };
  }

  return { locked: false, retryAfter: 0 };
}

/** Clears the failed-attempt counter for `role`+`email` (call on success). */
async function clearFailedLoginAttempts(role, email) {
  const aKey = attemptKey(role, email);
  if (redisEnabled) {
    await redis.del(aKey);
  } else {
    memoryAttempts.delete(aKey);
  }
}

/** Test-only: clears every in-process fallback entry between test runs. */
function _resetForTests() {
  memoryAttempts.clear();
  memoryLocks.clear();
}

module.exports = {
  isLoginLocked,
  registerFailedLogin,
  clearFailedLoginAttempts,
  getRandomLockSeconds,
  _resetForTests,
};
