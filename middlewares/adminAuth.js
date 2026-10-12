const config = require('../config/environment');
const { verifySupabaseToken } = require('../utils/supabaseAuth');
const { isAllowlisted, evaluateSession, jwtClaim } = require('../utils/adminSession');
const { DEFAULT_ROLES, can } = require('../utils/adminPermissions');
const { writeAudit } = require('../utils/adminAudit');
const User = require('../models/User');
const Role = require('../models/Role');
const AdminSession = require('../models/AdminSession');

// v1 has exactly one administrator and that account is always super_admin
// (openspec: admin-rbac-permissions, "Single administrator in v1").
const V1_ROLE = 'super_admin';

let rolesSeeded = false;
async function ensureRoles() {
  if (rolesSeeded) return;
  for (const r of DEFAULT_ROLES) {
    await Role.updateOne({ name: r.name }, { $setOnInsert: r }, { upsert: true });
  }
  rolesSeeded = true;
}

const deny = (res, status, code, message) =>
  res.status(status).json({ success: false, code, message });

/**
 * Admin API gate. Every request is checked here, independently of the web
 * app: valid token, verified allowlisted email, linked `admin` user, and a
 * live session (30 min idle / 12 h absolute). Fails closed.
 */
async function adminAuth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.split(' ')[1] : null;
    if (!token) return deny(res, 401, 'no_token', 'Not authorised');

    let supabaseUser;
    try {
      supabaseUser = await verifySupabaseToken(token);
    } catch {
      return deny(res, 401, 'invalid_token', 'Not authorised');
    }

    const email = (supabaseUser.email || '').toLowerCase();
    const verified = Boolean(supabaseUser.email_confirmed_at || supabaseUser.confirmed_at);
    if (!verified || !isAllowlisted(email, config.admin.emails)) {
      await writeAudit(req, {
        actorEmail: email,
        action: 'admin.sign_in',
        outcome: 'denied',
        reason: verified ? 'email_not_allowlisted' : 'email_not_verified',
      }).catch(() => {});
      return deny(res, 403, 'not_authorised', 'This account is not authorised');
    }

    // Link (or create on first sign-in) the Mongo user for the allowlisted email.
    let user = await User.findOne({ supabaseUserId: supabaseUser.id });
    if (!user) {
      const byEmail = await User.findOne({ email });
      if (byEmail && byEmail.role !== 'admin') {
        await writeAudit(req, {
          actorEmail: email,
          action: 'admin.sign_in',
          outcome: 'denied',
          reason: 'email_belongs_to_non_admin_account',
        }).catch(() => {});
        return deny(
          res,
          403,
          'email_conflict',
          'This email already belongs to a non-admin account'
        );
      }
      if (byEmail) {
        byEmail.supabaseUserId = supabaseUser.id;
        user = await byEmail.save();
      } else {
        user = await User.create({
          supabaseUserId: supabaseUser.id,
          email,
          role: 'admin',
          profile: { fullName: supabaseUser.user_metadata?.full_name || 'Administrator' },
          healthProfile: { bmi: 0, weightIndex: 0 },
          isVerified: true,
        });
      }
    }
    if (user.role !== 'admin') return deny(res, 403, 'forbidden', 'Not authorised');
    if (user.isActive === false) return deny(res, 403, 'account_disabled', 'Account disabled');

    // Session policy, enforced server-side.
    const sessionId = jwtClaim(token, 'session_id') || `${supabaseUser.id}:${jwtClaim(token, 'iat')}`;
    const now = Date.now();
    let session = await AdminSession.findOne({ sessionId });
    let firstSeen = false;
    if (!session) {
      session = await AdminSession.create({
        sessionId,
        userId: user._id,
        email,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });
      firstSeen = true;
    } else {
      const verdict = evaluateSession(session, now, config.admin);
      if (!verdict.ok) {
        if (verdict.reason !== 'revoked') {
          await AdminSession.updateOne(
            { _id: session._id },
            { $set: { revokedAt: new Date(), revokedReason: verdict.reason } }
          );
        }
        return deny(res, 401, 'session_expired', `Session ended (${verdict.reason})`);
      }
      // Cheap write-throttle: only touch the row when it is at least 30 s old.
      if (now - new Date(session.lastSeenAt).getTime() > 30000) {
        session.lastSeenAt = new Date(now);
        await AdminSession.updateOne({ _id: session._id }, { $set: { lastSeenAt: session.lastSeenAt } });
      }
    }

    await ensureRoles();
    const role = await Role.findOne({ name: V1_ROLE }).lean();

    req.user = user; // keeps upload filenames etc. working
    req.admin = {
      user,
      email,
      token,
      sessionId,
      session,
      role: V1_ROLE,
      permissions: role?.permissions || {},
    };

    if (firstSeen) {
      await writeAudit(req, { action: 'admin.sign_in', outcome: 'success' });
    }
    next();
  } catch (err) {
    next(err);
  }
}

/** Deny-by-default permission guard for a resource/action pair. */
const requirePermission = (resource, action) => (req, res, next) => {
  if (!req.admin || !can(req.admin.permissions, resource, action)) {
    return deny(res, 403, 'forbidden', 'You do not have permission to do that');
  }
  next();
};

module.exports = { adminAuth, requirePermission, ensureRoles };
