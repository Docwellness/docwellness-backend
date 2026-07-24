/**
 * Optional Redis client - AI_EXECUTION_PLAN.md Phase 5 (P5-06/P5-07/P5-09).
 *
 * Redis must be optional in development: when REDIS_URL isn't configured,
 * `client` stays null and every caller (utils/cache.js, rateLimiters.js,
 * app.js's Socket.IO adapter wiring) checks `isEnabled`/`client` and falls
 * back to its current no-Redis behavior - nothing in this codebase should
 * ever hard-require a reachable Redis instance to boot or serve a request.
 */

const config = require('./../config/environment');

let client = null;

if (config.redisUrl) {
  // eslint-disable-next-line global-require
  const Redis = require('ioredis');
  client = new Redis(config.redisUrl, {
    // Cap reconnect attempts' backoff instead of the default unbounded
    // exponential growth - a long-dead Redis shouldn't slow down every
    // future reconnect attempt indefinitely.
    retryStrategy: (times) => Math.min(times * 200, 5000),
    // Don't let a slow/unreachable Redis block application code that's
    // already been written to await client calls - ioredis queues commands
    // by default while disconnected, which can hang a request; callers here
    // always go through utils/cache.js's try/catch instead of raw commands.
    maxRetriesPerRequest: 2,
  });

  client.on('error', (err) => {
    // Never let a Redis-level error crash the process - caching/adapter use
    // is explicitly best-effort. Logged once per event, not thrown.
    console.error('[redis] connection error:', err.message);
  });

  client.on('connect', () => {
    console.log('[redis] connected');
  });
}

module.exports = {
  client,
  isEnabled: Boolean(client),
};
