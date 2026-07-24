// Request logging with a per-request ID (AI_EXECUTION_PLAN.md Phase 2,
// P2-06). Every request gets a short nanoid, exposed as `req.id` (pino-http
// sets this automatically from genReqId) and echoed back as the
// `X-Request-Id` response header so a client-reported issue can be
// correlated to a specific log line. Sensitive fields are redacted from
// the logged request/response, never the request itself - the app still
// sees the real authorization header etc., only the log output is scrubbed.
const pinoHttp = require('pino-http');
const { nanoid } = require('nanoid');

const requestLogger = pinoHttp({
  genReqId: (req, res) => {
    const id = nanoid(12);
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
