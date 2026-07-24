// Centralized error-handling middleware. Behavior for every error shape
// the previous middlewares/errorHandler.js already special-cased
// (Mongoose CastError/duplicate-key/ValidationError, JWT errors) is
// preserved exactly - this only ADDS awareness of the new ApiError class
// (see utils/api-error.js) on top. errorHandler.js now re-exports this
// file for backward compatibility (nothing outside middlewares/index.js
// required it directly, but keeping the old name/path working costs
// nothing and matches AI_RULES.md's "keep legacy APIs working").
//
// Response shape is unchanged from before at the top level
// (`{success:false, message}`, the shape every existing Flutter-side
// response parser in both apps reads) - a new `error: {code, message,
// details?}` object is added alongside it, additive only, for new/
// migrated callers to read a machine-readable code from. See
// AI_EXECUTION_PLAN.md Phase 2's "do not break existing API responses
// abruptly".
const ApiError = require('../utils/api-error');

const errorHandler = (err, req, res, next) => {
  let statusCode = err.statusCode || 500;
  let message = err.message || 'Server Error';
  let code = err.isApiError ? err.code : undefined;
  let details = err.isApiError ? err.details : undefined;

  // Mongoose bad ObjectId
  if (err.name === 'CastError') {
    statusCode = 404;
    message = 'Resource not found';
  }

  // Mongoose duplicate key
  if (err.code === 11000) {
    const field = Object.keys(err.keyValue || {})[0];
    statusCode = 400;
    message = field ? `${field} already exists` : 'Duplicate value';
  }

  // Mongoose validation error
  if (err.name === 'ValidationError' && err.errors) {
    statusCode = 400;
    message = Object.values(err.errors)
      .map((val) => val.message)
      .join(', ');
  }

  // JWT errors
  if (err.name === 'JsonWebTokenError') {
    statusCode = 401;
    message = 'Invalid token';
  }

  if (err.name === 'TokenExpiredError') {
    statusCode = 401;
    message = 'Token expired';
  }

  code = code || ApiError.defaultCodeForStatus(statusCode);

  // Log error for debugging - unchanged from the previous errorHandler.js.
  console.error(err);

  res.status(statusCode).json({
    success: false,
    message,
    error: { code, message, ...(details !== undefined ? { details } : {}) },
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
  });
};

module.exports = errorHandler;
