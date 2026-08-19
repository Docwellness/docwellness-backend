/**
 * Device-risk header capture for login routes (AI_EXECUTION_PLAN.md Phase 9,
 * P9-B5). `X-Jailbreak-Detected`/`X-Root-Detected` are client-reported and
 * therefore untrusted input - any app can lie about them - so this is
 * capture-and-coarse-policy only, not real attestation. Validating a signed
 * attestation token (Play Integrity / App Attest) is a larger follow-up,
 * deliberately out of scope here.
 *
 * Policy differs by app: DocDesk (dietician) handles patient PHI, so a
 * jailbroken/rooted signal blocks login outright. The patient app has a
 * lower trust bar - the signal is only recorded (see authController.login's
 * device_risk_flagged audit event), not blocking.
 *
 * `loginRole(role)` is a separate tiny middleware (not device-specific)
 * that stamps `req.loginRole` so the shared login/refresh controller
 * (mounted at both /api/patient and /api/dietician) knows which lockout
 * threshold and device-risk policy applies, without having to infer it
 * from the request path.
 */

const { logAuditEvent } = require('../utils/auditLog');

function loginRole(role) {
  return (req, res, next) => {
    req.loginRole = role;
    next();
  };
}

function deviceRiskGate(role) {
  return (req, res, next) => {
    const jailbreak = req.headers['x-jailbreak-detected'] === 'true';
    const rooted = req.headers['x-root-detected'] === 'true';
    req.deviceRisk = { jailbreak, rooted };

    if (!jailbreak && !rooted) {
      return next();
    }

    const email = (req.body && req.body.email ? String(req.body.email) : '').trim().toLowerCase();

    if (role === 'dietician') {
      logAuditEvent('device_risk_blocked', { role, email, jailbreak, rooted });
      return res.status(403).json({
        success: false,
        message: 'This device cannot be used to sign in.',
      });
    }

    logAuditEvent('device_risk_flagged', { role, email, jailbreak, rooted });
    next();
  };
}

module.exports = { loginRole, deviceRiskGate };
