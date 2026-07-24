// Rate limiters for the specific route groups AI_EXECUTION_PLAN.md Phase 2
// (P2-04) calls out: auth, message sending, AI generation, uploads. Applied
// per-route (see routes/patient.js, routes/dietician.js, chat/routes/
// index.js) rather than globally - most of the API has no abuse-prone
// shape and a blanket limit would just be noise. Response body matches the
// existing `{success:false, message}` shape used everywhere else, so a
// 429 looks like any other handled error to existing Flutter-side code.
const rateLimit = require('express-rate-limit');

function makeLimiter({ windowMs, limit, message }) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, message },
  });
}

// Signup/forgot-password/email-check - spam and enumeration-prone. Actual
// login happens client-side against Supabase, not this backend, so there's
// no traditional "login form" endpoint here to protect against brute force.
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
