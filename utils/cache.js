/**
 * Small JSON cache helper over the optional Redis client (utils/redisClient.js).
 * AI_EXECUTION_PLAN.md Phase 5, P5-06 - used for dashboard/unread-count
 * caching. Every method degrades to "always call fetchFn / no-op" when
 * Redis isn't configured or a call fails, so a cache outage or missing
 * REDIS_URL never breaks the underlying feature - only its cache speedup.
 */

const { client, isEnabled } = require('./redisClient');

/**
 * Returns the cached JSON value for `key` if present, otherwise calls
 * `fetchFn`, caches its result for `ttlSeconds`, and returns it.
 * @param {string} key
 * @param {number} ttlSeconds
 * @param {() => Promise<any>} fetchFn
 */
async function getOrSetJSON(key, ttlSeconds, fetchFn) {
  if (!isEnabled) {
    return fetchFn();
  }

  try {
    const cached = await client.get(key);
    if (cached !== null) {
      return JSON.parse(cached);
    }
  } catch (err) {
    console.error(`[cache] read failed for ${key}:`, err.message);
  }

  const value = await fetchFn();

  try {
    await client.set(key, JSON.stringify(value), 'EX', ttlSeconds);
  } catch (err) {
    console.error(`[cache] write failed for ${key}:`, err.message);
  }

  return value;
}

/**
 * Best-effort cache invalidation - swallows errors, never throws.
 * @param {string|string[]} keyOrKeys
 */
async function invalidate(keyOrKeys) {
  if (!isEnabled) return;
  const keys = Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys];
  if (keys.length === 0) return;
  try {
    await client.del(...keys);
  } catch (err) {
    console.error('[cache] invalidate failed:', err.message);
  }
}

module.exports = { getOrSetJSON, invalidate };
