// Response-shaping helpers for new/migrated controllers. Deliberately
// matches the shape every existing controller already hand-rolls
// (`{success:true, data}` / `{success:false, message}`) rather than the
// plan's literal `{success:false, error:{code,message}}` alone - adding a
// NEW nested `error` object alongside the existing top-level `message`
// field, never replacing it, so no existing Flutter-side response parsing
// (which reads `response.data['message']` directly, in both apps) breaks.
// See AI_EXECUTION_PLAN.md Phase 2's "do not break existing API responses
// abruptly".
//
// Existing controllers are not required to adopt these - they're additive,
// for new/migrated code (see middlewares/error.js, utils/async-handler.js).

const ApiError = require('./api-error');

function sendSuccess(res, { statusCode = 200, data, message, pagination } = {}) {
  const body = { success: true };
  if (data !== undefined) body.data = data;
  if (message !== undefined) body.message = message;
  if (pagination !== undefined) body.pagination = pagination;
  return res.status(statusCode).json(body);
}

function sendError(res, { statusCode = 500, message = 'Server Error', code, details } = {}) {
  const body = {
    success: false,
    message,
    error: {
      code: code || ApiError.defaultCodeForStatus(statusCode),
      message,
      ...(details !== undefined ? { details } : {}),
    },
  };
  return res.status(statusCode).json(body);
}

module.exports = { sendSuccess, sendError };
