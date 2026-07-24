// Backward-compat re-export - the actual implementation moved to
// middlewares/error.js (see AI_EXECUTION_PLAN.md Phase 2, P2-01). Nothing
// outside middlewares/index.js required this file directly at the time of
// this change, but kept working under its original name/path regardless,
// per AI_RULES.md's "keep legacy APIs working during migration".
module.exports = require('./error');
