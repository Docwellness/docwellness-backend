// AI_EXECUTION_PLAN.md Phase 8, P8-01 - nanoid v6 ships as pure ESM, which
// Jest's default CommonJS transform can't parse (only middlewares/
// requestLogger.js uses it, for per-request log ids - not something these
// integration tests assert on). Swapped in via jest.config.js's
// moduleNameMapper instead of reconfiguring Jest's transform for ESM,
// which would be a much larger, riskier change for a dependency this
// narrowly used.
function nanoid(size = 21) {
  let id = '';
  for (let i = 0; i < size; i += 1) {
    id += Math.floor(Math.random() * 36).toString(36);
  }
  return id;
}

module.exports = { nanoid };
