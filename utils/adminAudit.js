const AdminAuditLog = require('../models/AdminAuditLog');

/**
 * Writes one append-only audit entry for the current admin request
 * (openspec: admin-audit-log). Never swallows errors: a caller that needs the
 * action to be recorded must let this failure abort the action.
 */
async function writeAudit(req, fields) {
  const admin = req.admin || {};
  return AdminAuditLog.create({
    actorId: admin.user?._id,
    actorEmail: admin.email || fields.actorEmail,
    outcome: 'success',
    ip: req.ip,
    userAgent: req.headers?.['user-agent'],
    requestId: req.id || req.headers?.['x-request-id'],
    ...fields,
  });
}

/**
 * Records the intent first, then runs the mutation. If the audit write fails
 * the mutation never runs (the action must not complete unrecorded). If the
 * mutation then throws, a compensating `failed` entry is appended, since the
 * log itself can never be edited.
 */
async function audited(req, entry, mutate) {
  await writeAudit(req, entry);
  try {
    return await mutate();
  } catch (err) {
    await writeAudit(req, {
      action: entry.action,
      targetType: entry.targetType,
      targetId: entry.targetId,
      outcome: 'failed',
      meta: { error: String(err?.message || err).slice(0, 300) },
    }).catch(() => {});
    throw err;
  }
}

module.exports = { writeAudit, audited };
