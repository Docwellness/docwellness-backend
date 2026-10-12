/**
 * Pure helpers for admin session policy and the email allowlist
 * (openspec: admin-auth-access). No I/O so they are easy to test.
 */

function isAllowlisted(email, allowlist) {
  if (!email || typeof email !== 'string') return false;
  const e = email.trim().toLowerCase();
  return (allowlist || []).some((a) => a === e);
}

/**
 * @returns {{ok: true} | {ok: false, reason: 'idle'|'absolute'|'revoked'}}
 */
function evaluateSession(session, now, { idleMinutes, absoluteHours }) {
  if (session.revokedAt) return { ok: false, reason: 'revoked' };
  const started = new Date(session.startedAt).getTime();
  const lastSeen = new Date(session.lastSeenAt).getTime();
  if (now - started > absoluteHours * 3600 * 1000) return { ok: false, reason: 'absolute' };
  if (now - lastSeen > idleMinutes * 60 * 1000) return { ok: false, reason: 'idle' };
  return { ok: true };
}

/** Reads a claim from a JWT without verifying it (the token is verified elsewhere). */
function jwtClaim(token, claim) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return payload[claim];
  } catch {
    return undefined;
  }
}

module.exports = { isAllowlisted, evaluateSession, jwtClaim };
