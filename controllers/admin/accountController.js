const config = require('../../config/environment');
const { getSupabaseAdmin } = require('../../utils/supabaseAuth');
const { writeAudit } = require('../../utils/adminAudit');
const AdminSession = require('../../models/AdminSession');
const AdminAuditLog = require('../../models/AdminAuditLog');
const Role = require('../../models/Role');

// GET /api/admin/me
exports.me = async (req, res) => {
  const { user, email, role, permissions, session } = req.admin;
  const idleMs = config.admin.idleMinutes * 60 * 1000;
  const absoluteMs = config.admin.absoluteHours * 3600 * 1000;
  res.json({
    success: true,
    data: {
      email,
      name: user.profile?.fullName || 'Administrator',
      role,
      permissions,
      session: {
        startedAt: session.startedAt,
        idleExpiresAt: new Date(Date.now() + idleMs),
        absoluteExpiresAt: new Date(new Date(session.startedAt).getTime() + absoluteMs),
      },
    },
  });
};

// POST /api/admin/session/logout-all
exports.logoutAll = async (req, res, next) => {
  try {
    await writeAudit(req, { action: 'admin.sign_out_all', targetType: 'session' });
    const result = await AdminSession.updateMany(
      { userId: req.admin.user._id, revokedAt: { $exists: false } },
      { $set: { revokedAt: new Date(), revokedReason: 'sign_out_all' } }
    );
    // Best effort: also end the identity provider sessions.
    await getSupabaseAdmin()
      .auth.admin.signOut(req.admin.token, 'global')
      .catch(() => {});
    res.json({ success: true, data: { revoked: result.modifiedCount } });
  } catch (err) {
    next(err);
  }
};

// GET /api/admin/roles
exports.listRoles = async (req, res, next) => {
  try {
    const roles = await Role.find({}).sort({ name: 1 }).lean();
    res.json({ success: true, data: roles });
  } catch (err) {
    next(err);
  }
};

const auditFilter = (q) => {
  const f = {};
  if (q.action) f.action = q.action;
  if (q.actor) f.actorEmail = String(q.actor).toLowerCase();
  if (q.targetType) f.targetType = q.targetType;
  if (q.targetId) f.targetId = q.targetId;
  if (q.outcome) f.outcome = q.outcome;
  if (q.from || q.to) {
    f.createdAt = {};
    if (q.from) f.createdAt.$gte = new Date(q.from);
    if (q.to) f.createdAt.$lte = new Date(q.to);
  }
  return f;
};

// GET /api/admin/audit
exports.listAudit = async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 25));
    const filter = auditFilter(req.query);
    const [items, total] = await Promise.all([
      AdminAuditLog.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      AdminAuditLog.countDocuments(filter),
    ]);
    res.json({ success: true, data: { items, total, page, limit } });
  } catch (err) {
    next(err);
  }
};

const csvCell = (v) => {
  if (v === undefined || v === null) return '';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// GET /api/admin/audit/export  (export is itself audited)
exports.exportAudit = async (req, res, next) => {
  try {
    const filter = auditFilter(req.query);
    await writeAudit(req, { action: 'audit.export', targetType: 'audit', meta: { filter: req.query } });
    const rows = await AdminAuditLog.find(filter).sort({ createdAt: -1 }).limit(20000).lean();
    const cols = [
      'createdAt',
      'actorEmail',
      'action',
      'outcome',
      'targetType',
      'targetId',
      'reason',
      'before',
      'after',
      'ip',
      'userAgent',
      'requestId',
    ];
    const csv = [cols.join(',')]
      .concat(rows.map((r) => cols.map((c) => csvCell(r[c])).join(',')))
      .join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="audit-log.csv"');
    res.send(csv);
  } catch (err) {
    next(err);
  }
};
