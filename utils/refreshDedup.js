/**
 * De-duplicates concurrent refresh-token exchanges (AI_EXECUTION_PLAN.md
 * Phase 9, P9-B3). This deliberately does NOT reimplement refresh-token
 * rotation/reuse-detection - Supabase already owns that (see
 * utils/supabaseAuth.js's refreshSession). The actual bug this closes is
 * concurrency: several requests carrying the same refresh token, arriving
 * within milliseconds of each other (e.g. a Flutter app's proactive refresh
 * firing from multiple in-flight requests at once), can otherwise each
 * independently call Supabase's refreshSession - and since Supabase itself
 * rotates the refresh token on use, the second concurrent call sees the
 * first call's rotation and fails with a spurious "invalid refresh token".
 *
 * Two layers, both keyed by a SHA-256 hash of the refresh token (never the
 * raw token itself, in memory or in Redis):
 *  - `inFlight`: an in-process Promise map. Covers the common case of two
 *    requests landing on the same server instance a few ms apart - no
 *    Redis round-trip needed, and works even when Redis isn't configured.
 *  - a short Redis result cache (when Redis is enabled): extends the same
 *    protection across separate instances/invocations for a few seconds
 *    after the first successful refresh, same optional-Redis "never
 *    hard-fail without it" convention as utils/redisClient.js.
 */

const crypto = require('crypto');
const { client: redis, isEnabled: redisEnabled } = require('./redisClient');

const RESULT_CACHE_TTL_SECONDS = 8;

const inFlight = new Map();

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

async function readCachedResult(key) {
  if (!redisEnabled) return null;
  const raw = await redis.get(`refresh_dedup:${key}`);
  return raw ? JSON.parse(raw) : null;
}

async function writeCachedResult(key, session) {
  if (!redisEnabled) return;
  await redis.set(`refresh_dedup:${key}`, JSON.stringify(session), 'EX', RESULT_CACHE_TTL_SECONDS);
}

/**
 * Runs `performRefresh()` deduplicated by `refreshToken`. Returns
 * `{ session, deduped }` - `deduped: true` means the caller got a result
 * from an in-flight or recently-cached refresh rather than triggering a new
 * Supabase call itself. Rejects with whatever `performRefresh()` rejects
 * with (every concurrent caller sharing that in-flight call gets the same
 * error).
 */
async function dedupedRefresh(refreshToken, performRefresh) {
  const key = hashToken(refreshToken);

  if (inFlight.has(key)) {
    const session = await inFlight.get(key);
    return { session, deduped: true };
  }

  const cachedSession = await readCachedResult(key);
  if (cachedSession) {
    return { session: cachedSession, deduped: true };
  }

  const promise = performRefresh().finally(() => inFlight.delete(key));
  inFlight.set(key, promise);

  const session = await promise;
  await writeCachedResult(key, session);
  return { session, deduped: false };
}

module.exports = { dedupedRefresh };
