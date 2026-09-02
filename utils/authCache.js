/**
 * Auth-token -> Supabase-user-id cache (cross-app performance optimization,
 * Phase 2, task 2.5).
 *
 * WHAT IS CACHED, AND WHY ONLY THIS:
 *   Every authenticated request runs `supabase.auth.getUser(token)` - a
 *   network round trip to Supabase's servers - just to learn "is this token
 *   a currently-valid session, and whose?". That's the latency this cache
 *   removes. It stores ONLY `sha256(token) -> supabaseUserId`.
 *
 *   It deliberately does NOT cache the resolved Mongo `User`. Per the
 *   DocWellness auth spec, a user's role / active-status / profile must be
 *   read from the database on every request, never trusted from a cached
 *   copy - so `getUserFromSupabaseToken` still does its own
 *   `User.findOne({ supabaseUserId })` on a cache hit.
 *
 * SAFETY:
 *   - TTL is capped at min(90s, the token's own `exp`). A cache hit can
 *     therefore never outlive the JWT.
 *   - Deliberate revocation (logout) calls `invalidateToken`.
 *   - Account deletion is self-healing: the Mongo User is gone too, so a
 *     cache hit resolves to no user and falls through to the full
 *     verify path, which then 401s.
 *   - Degrades to a no-op when REDIS_URL isn't configured (same convention
 *     as utils/redisClient.js / utils/cache.js).
 */

const crypto = require('crypto');
const { client, isEnabled } = require('./redisClient');

const KEY_PREFIX = 'authtok:';
const MAX_TTL_SECONDS = 90;

const keyFor = (token) =>
  `${KEY_PREFIX}${crypto.createHash('sha256').update(token).digest('hex')}`;

/**
 * Reads the JWT `exp` claim WITHOUT verifying the signature - used only to
 * cap the cache TTL. The signature and expiry are still fully verified by
 * `supabase.auth.getUser()` on every cache miss.
 * @returns {number|null} epoch seconds, or null if unparseable
 */
function jwtExpSeconds(token) {
  try {
    const payloadB64 = token.split('.')[1];
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64').toString('utf8'));
    return typeof payload.exp === 'number' ? payload.exp : null;
  } catch {
    return null;
  }
}

/**
 * @returns {Promise<string|null>} the cached supabaseUserId for a token that
 *   was a valid session within the last <=90s, or null on miss / disabled /
 *   error / past the token's own exp.
 */
async function getCachedUserId(token) {
  if (!isEnabled || !token) return null;
  const exp = jwtExpSeconds(token);
  if (exp !== null && Date.now() / 1000 >= exp) return null;
  try {
    return await client.get(keyFor(token));
  } catch (err) {
    console.error('[authCache] read failed:', err.message);
    return null;
  }
}

async function setCachedUserId(token, supabaseUserId) {
  if (!isEnabled || !token || !supabaseUserId) return;
  let ttl = MAX_TTL_SECONDS;
  const exp = jwtExpSeconds(token);
  if (exp !== null) {
    const remaining = Math.floor(exp - Date.now() / 1000);
    if (remaining <= 0) return;
    ttl = Math.min(ttl, remaining);
  }
  try {
    await client.set(keyFor(token), String(supabaseUserId), 'EX', ttl);
  } catch (err) {
    console.error('[authCache] write failed:', err.message);
  }
}

/** Purge one token's cached resolution (called on logout). */
async function invalidateToken(token) {
  if (!isEnabled || !token) return;
  try {
    await client.del(keyFor(token));
  } catch (err) {
    console.error('[authCache] invalidate failed:', err.message);
  }
}

module.exports = { getCachedUserId, setCachedUserId, invalidateToken, jwtExpSeconds };
