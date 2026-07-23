/**
 * Parses a "DD-MM-YYYY" string (the wire format used for dateOfBirth
 * everywhere in this API - see User.js's toJSON transform, which formats it
 * back to this same shape) into a real Date. Needed because a Mongoose
 * Date-typed field's own automatic cast can't reliably parse this format
 * (new Date("15-05-1994") is Invalid Date in V8, since it's neither ISO nor
 * a format V8's non-ISO fallback parser recognizes) - assigning the raw
 * string directly crashes with a CastError instead of failing gracefully.
 * Returns null for anything that isn't a well-formed DD-MM-YYYY string.
 */
function parseDateFromDDMMYYYY(value) {
  if (!value || typeof value !== 'string') {
    return null;
  }
  const [day, month, year] = value.split('-');
  if (!(day && month && year)) {
    return null;
  }
  const parsed = new Date(`${year}-${month}-${day}`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Like parseDateFromDDMMYYYY, but also accepts an already-ISO ("YYYY-MM-DD")
 * string - for endpoints/fields that have historically received either
 * shape from different callers (e.g. createDietPlanRequest's dateOfBirth,
 * which crashed in production - Sentry CastError - because it assigned
 * whatever string arrived straight into a Date-typed field with no
 * parsing at all). Returns null rather than throwing for anything that
 * doesn't match either shape, so a malformed value is silently dropped
 * instead of crashing the whole request.
 */
function parseFlexibleDate(value) {
  if (!value || typeof value !== 'string') {
    return null;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return parseDateFromDDMMYYYY(value);
}

module.exports = { parseDateFromDDMMYYYY, parseFlexibleDate };
