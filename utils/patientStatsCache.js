/**
 * Per-patient stats cache (cross-app performance optimization, Phase 2,
 * task 2.6).
 *
 * The patient Home / Diet screens repeatedly request the same computed
 * meal-log stats for the same day (poll, prev/next-day nav, ±1 day
 * prefetch, pull-to-refresh, app resume) - each call re-runs a DietPlan +
 * MealLog + Recipe fetch and a stack of per-meal ratio math. This caches
 * the computed result, keyed per patient + window, and wipes every cached
 * window for a patient whenever their meal logs change (their own writes,
 * so their view is always immediately fresh; a short TTL is the backstop
 * for dietician-side plan / recipe edits).
 *
 * Built on utils/cache.js's getOrSetJSON; degrades to "always compute" when
 * REDIS_URL isn't set (same convention as the rest of utils/).
 */

const { client, isEnabled } = require('./redisClient');
const { getOrSetJSON } = require('./cache');

const INDEX_TTL_SECONDS = 3600; // bounds index growth if an invalidation is ever missed
const indexKey = (patientId) => `pstat:idx:${patientId}`;

/**
 * getOrSetJSON, plus: register `key` in the patient's key-index set so
 * invalidatePatientStats can drop every cached window in one call.
 * @param {string} patientId
 * @param {string} key      full cache key (namespace it yourself, e.g. `pstat:mealtoday:<id>:<date>`)
 * @param {number} ttlSeconds
 * @param {() => Promise<any>} fetchFn
 */
async function getOrSetPatientStat(patientId, key, ttlSeconds, fetchFn) {
  if (isEnabled) {
    try {
      await client
        .multi()
        .sadd(indexKey(patientId), key)
        .expire(indexKey(patientId), INDEX_TTL_SECONDS)
        .exec();
    } catch (err) {
      console.error('[patientStatsCache] index add failed:', err.message);
    }
  }
  return getOrSetJSON(key, ttlSeconds, fetchFn);
}

/**
 * Wipe every cached stat window for a patient. Call from every handler that
 * mutates that patient's meal logs. Best-effort - never throws.
 */
async function invalidatePatientStats(patientId) {
  if (!isEnabled || !patientId) return;
  const idx = indexKey(String(patientId));
  try {
    const keys = await client.smembers(idx);
    if (keys.length > 0) await client.del(...keys);
    await client.del(idx);
  } catch (err) {
    console.error('[patientStatsCache] invalidate failed:', err.message);
  }
}

module.exports = { getOrSetPatientStat, invalidatePatientStats };
