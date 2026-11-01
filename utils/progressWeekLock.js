/**
 * Short-lived lock that serialises weight entries for one patient and week, so
 * two simultaneous creates (a double tap, a retry) cannot both pass the
 * "week already logged" check. Backed by the IdempotencyKey collection, whose
 * unique `key` index makes the insert atomic.
 */

const { IdempotencyKey } = require('../chat/models');

const STALE_LOCK_MS = 60 * 1000;

const lockKey = (patientId, week) => `progress-week:${patientId}:${week}`;

async function insertLock(key, patientId) {
  await IdempotencyKey.create({
    key,
    userId: patientId,
    endpoint: '/api/patient/progress',
    method: 'POST',
    status: 'pending',
    lockedAt: new Date(),
  });
}

function releaser(key) {
  return {
    release: async () => {
      try {
        await IdempotencyKey.deleteOne({ key });
      } catch (error) {
        console.error('progressWeekLock: release failed', error.message);
      }
    },
  };
}

/**
 * @returns {Promise<{release: Function}|null>} the lock, or null when another
 * request holds it. A failure of the guard itself never blocks the weight: it
 * is logged and the caller proceeds without a lock.
 */
async function acquireProgressWeekLock(patientId, week) {
  const key = lockKey(patientId, week);
  try {
    await insertLock(key, patientId);
    return releaser(key);
  } catch (error) {
    if (error.code !== 11000) {
      console.error('progressWeekLock: acquire failed, continuing without a lock', error.message);
      return { release: async () => {} };
    }
  }

  try {
    const held = await IdempotencyKey.findOne({ key }).select('_id lockedAt').lean();
    const fresh = held && Date.now() - new Date(held.lockedAt).getTime() <= STALE_LOCK_MS;
    if (fresh) return null;
    // Stale (or just released): take over only if nobody else already did.
    if (held) {
      const { deletedCount } = await IdempotencyKey.deleteOne({
        _id: held._id,
        lockedAt: held.lockedAt,
      });
      if (!deletedCount) return null;
    }
    await insertLock(key, patientId);
    return releaser(key);
  } catch (error) {
    if (error.code === 11000) return null;
    console.error('progressWeekLock: takeover failed, continuing without a lock', error.message);
    return { release: async () => {} };
  }
}

module.exports = { acquireProgressWeekLock, STALE_LOCK_MS };
