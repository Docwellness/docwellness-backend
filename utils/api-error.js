// Structured error type for new/migrated controllers to throw instead of
// hand-rolling `res.status(x).json({success:false, message:...})` - see
// middlewares/error.js for how this gets turned into a response, and
// utils/async-handler.js for how a thrown ApiError reaches that middleware
// from an async controller.
//
// Existing controllers that already do their own try/catch +
// res.status().json({success:false, message}) are NOT required to change -
// this is additive infrastructure for new code (see AI_EXECUTION_PLAN.md
// Phase 2's "keep legacy routes working" / "do not break existing API
// responses abruptly" constraints), not a mandatory migration.
class ApiError extends Error {
  /**
   * @param {number} statusCode - HTTP status code.
   * @param {string} message - human-readable message (also becomes the
   *   response's top-level `message` field, matching every existing error
   *   response's shape).
   * @param {string} [code] - machine-readable error code (e.g.
   *   'NOT_FOUND', 'VALIDATION_ERROR'). Defaults to a code derived from
   *   statusCode if omitted.
   * @param {*} [details] - optional extra structured info (e.g. per-field
   *   validation errors) included in the response's `error.details`.
   */
  constructor(statusCode, message, code, details) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.code = code || ApiError.defaultCodeForStatus(statusCode);
    this.details = details;
    this.isApiError = true;
    Error.captureStackTrace?.(this, ApiError);
  }

  static defaultCodeForStatus(statusCode) {
    switch (statusCode) {
      case 400:
        return 'BAD_REQUEST';
      case 401:
        return 'UNAUTHORIZED';
      case 403:
        return 'FORBIDDEN';
      case 404:
        return 'NOT_FOUND';
      case 409:
        return 'CONFLICT';
      case 422:
        return 'UNPROCESSABLE_ENTITY';
      case 429:
        return 'TOO_MANY_REQUESTS';
      default:
        return statusCode >= 500 ? 'INTERNAL_ERROR' : 'ERROR';
    }
  }

  static badRequest(message, code, details) {
    return new ApiError(400, message, code, details);
  }

  static unauthorized(message = 'Unauthorized', code, details) {
    return new ApiError(401, message, code, details);
  }

  static forbidden(message = 'Forbidden', code, details) {
    return new ApiError(403, message, code, details);
  }

  static notFound(message = 'Resource not found', code, details) {
    return new ApiError(404, message, code, details);
  }

  static conflict(message, code, details) {
    return new ApiError(409, message, code, details);
  }

  static internal(message = 'Server Error', code, details) {
    return new ApiError(500, message, code, details);
  }
}

module.exports = ApiError;
