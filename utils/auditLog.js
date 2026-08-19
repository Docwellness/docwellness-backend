/**
 * Structured audit logging for auth-security events (AI_EXECUTION_PLAN.md
 * Phase 9, P9-B6). Console-only for now, same level the rest of this app's
 * request/error logging operates at - not a durable/queryable store, just a
 * consistent, greppable shape for login/refresh/lockout/device-risk events.
 * Never pass password, tokens, or PHI in `metadata` - only role/email/event
 * bookkeeping.
 */
function logAuditEvent(event, metadata = {}) {
  const entry = {
    type: 'audit',
    event,
    timestamp: new Date().toISOString(),
    ...metadata,
  };
  console.log(JSON.stringify(entry));
}

module.exports = { logAuditEvent };
