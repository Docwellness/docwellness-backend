// Must be required before any other module in both entry points (app.js and
// api/index.js) so Sentry's auto-instrumentation can patch things like http
// and mongodb before they're loaded elsewhere. Loads dotenv itself so
// SENTRY_DSN is available before Sentry.init() runs.
require('dotenv').config();
const Sentry = require('@sentry/node');

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.NODE_ENV || 'development',
  // Keep at 0 to conserve the free-tier error quota for actual errors -
  // this only affects performance tracing, not error capture.
  tracesSampleRate: 0,
});

module.exports = Sentry;
