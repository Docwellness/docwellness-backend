// Rate limiters for the specific route groups AI_EXECUTION_PLAN.md Phase 2
// (P2-04) calls out: auth, message sending, AI generation, uploads. Applied
// per-route (see routes/patient.js, routes/dietician.js, chat/routes/
// index.js) rather than globally - most of the API has no abuse-prone
// shape and a blanket limit would just be noise. Response body matches the
// existing `{success:false, message}` shape used everywhere else, so a
// 429 looks like any other handled error to existing Flutter-side code.
const rateLimit = require('express-rate-limit');
const { client: redis, isEnabled: redisEnabled } = require('../utils/redisClient');

// Redis-backed store when available (P9-B4, AI_EXECUTION_PLAN.md Phase 9) -
// express-rate-limit's default in-memory store only tracks counts within a
// single process, which doesn't hold up on a multi-instance/serverless
// deployment (the Vercel-hosted dev-api). Falls back to the in-memory
// default when Redis isn't configured, same optional-Redis convention as
// utils/redisClient.js itself - never a hard requirement to boot.
let redisStoreFactory = null;
if (redisEnabled) {
  // eslint-disable-next-line global-require
  const { RedisStore } = require('rate-limit-redis');
  redisStoreFactory = () =>
    new RedisStore({
      sendCommand: (...args) => redis.call(...args),
    });
}

function makeLimiter({ windowMs, limit, message }) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, message },
    // A fresh store per limiter (not one shared instance) so each route
    // group's counters stay independent, matching the pre-Redis in-memory
    // behavior where every rateLimit() call already got its own store.
    store: redisStoreFactory ? redisStoreFactory() : undefined,
    // This is a per-IP window with no per-test reset hook, and every
    // integration test shares one supertest/127.0.0.1 "IP" across the whole
    // `--runInBand` Jest run (see jest.config.js) - without this, tests that
    // legitimately need to fire many requests at a rate-limited route (e.g.
    // tests/loginLockout.test.js exercising P9-B2's account-level lockout)
    // would trip this unrelated IP-level limiter first. No existing test
    // exercises this limiter's own 429 behavior, so skipping it under test
    // doesn't reduce coverage of anything.
    skip: () => process.env.NODE_ENV === 'test',
  });
}

// Signup/forgot-password/login/reset-password - spam, enumeration, and
// (now that authController.login is a real server-side endpoint - see
// AI_EXECUTION_PLAN.md Phase 9, P9-B1) brute-force-prone. Login additionally
// gets its own account-level lockout (utils/loginLockout.js, P9-B2) on top
// of this shared per-IP window.
const authLimiter = makeLimiter({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  message: 'Too many requests, please try again later.',
});

const messageLimiter = makeLimiter({
  windowMs: 60 * 1000,
  limit: 30,
  message: 'Too many messages sent, please slow down.',
});

// AI generation is the most expensive/abuse-prone category (OpenAI calls
// cost real money per request) - kept tighter than the others.
const aiGenerationLimiter = makeLimiter({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  message: 'Too many AI generation requests, please try again later.',
});

const uploadLimiter = makeLimiter({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  message: 'Too many uploads, please try again later.',
});

module.exports = { authLimiter, messageLimiter, aiGenerationLimiter, uploadLimiter };
