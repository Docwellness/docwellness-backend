// Request logging with a per-request ID (AI_EXECUTION_PLAN.md Phase 2,
// P2-06). Every request gets a short id, exposed as `req.id` (pino-http
// sets this automatically from genReqId) and echoed back as the
// `X-Request-Id` response header so a client-reported issue can be
// correlated to a specific log line. Sensitive fields are redacted from
// the logged request/response, never the request itself - the app still
// sees the real authorization header etc., only the log output is scrubbed.
//
// Uses crypto.randomUUID() (built into Node, no dependency) rather than
// nanoid - nanoid v6 ships as pure ESM, which crashed every single request
// in production with ERR_REQUIRE_ESM the moment this middleware first ran
// (require() can't load an ESM-only package). Confirmed via real Vercel
// runtime logs, not a local repro - this sandbox's own local node_modules/
// nanoid didn't reproduce it, only the actual deployed bundle did.
const pinoHttp = require('pino-http');
const crypto = require('crypto');

const requestLogger = pinoHttp({
  genReqId: (req, res) => {
    const id = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
    res.setHeader('X-Request-Id', id);
    return id;
  },
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.headers["set-cookie"]',
      'req.body.password',
      'req.body.currentPassword',
      'req.body.newPassword',
      'req.body.token',
      'req.body.otp',
      'req.body.otpCode',
      'req.body.accessToken',
      'req.body.refreshToken',
      'res.headers["set-cookie"]',
    ],
    censor: '[REDACTED]',
  },
  // Keep logs quiet in test runs and reasonably quiet in production; verbose
  // in development where a human is actually watching the console.
  level: process.env.NODE_ENV === 'test' ? 'silent' : process.env.NODE_ENV === 'development' ? 'debug' : 'info',
});

module.exports = requestLogger;
