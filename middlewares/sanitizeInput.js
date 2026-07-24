// NoSQL injection prevention (strips any object key starting with '$' or
// containing '.' - e.g. a spoofed {"$gt": ""} field reaching a Mongoose
// query unfiltered). Deliberately does NOT use express-mongo-sanitize's
// own middleware() factory directly - it unconditionally does
// `req.query = sanitized` internally, and Express 5 made `req.query` a
// getter-only accessor property (no setter) on the request object;
// calling that factory as normal middleware throws
// "Cannot set property query of #<IncomingMessage> which has only a
// getter" on literally every request that has any query string at all
// (confirmed empirically before writing this - it 500'd every GET request
// with a query param). express-mongo-sanitize's own `sanitize()` export
// (the underlying pure function, not the Express middleware wrapper) has
// no such problem since it doesn't touch req.query itself - only body and
// params are sanitized here; req.params is Express-managed per-route and
// stays fully assignable regardless.
//
// req.query is intentionally left alone: every route in this codebase
// already treats query-string values as opaque strings (parseInt, exact-
// match filters) rather than interpolating them into a raw Mongo query
// object the way an unfiltered body field could, so the risk this
// middleware protects against doesn't really apply there the same way -
// and there is no safe way to sanitize it in place under Express 5 short
// of monkey-patching the getter, which is a much larger, riskier change
// than this phase calls for.
const { sanitize } = require('express-mongo-sanitize');

function sanitizeInput(req, res, next) {
  if (req.body && typeof req.body === 'object') {
    req.body = sanitize(req.body);
  }
  if (req.params && typeof req.params === 'object') {
    req.params = sanitize(req.params);
  }
  next();
}

module.exports = sanitizeInput;
