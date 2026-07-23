const mongoose = require('mongoose');

/**
 * Express router.param callback - rejects a route param that isn't a
 * well-formed Mongo ObjectId with a clean 400 instead of letting a
 * malformed value (e.g. the literal string "undefined", seen in production
 * when a frontend interpolated an unset id into a URL - Sentry: CastError
 * for value "undefined" at path "_id"/"patient") reach Mongoose and crash
 * as an unhandled CastError deep inside a query.
 */
module.exports = function validateObjectIdParam(req, res, next, value, name) {
  if (!mongoose.Types.ObjectId.isValid(value)) {
    return res.status(400).json({
      success: false,
      message: `Invalid ${name || 'id'} parameter`,
    });
  }
  next();
};
