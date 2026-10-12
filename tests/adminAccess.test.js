/**
 * Admin panel: allowlist, session policy and permission helpers
 * (openspec change add-admin-panel; specs admin-auth-access, admin-rbac-permissions).
 */
const { isAllowlisted, evaluateSession, jwtClaim } = require('../utils/adminSession');
const { DEFAULT_ROLES, can } = require('../utils/adminPermissions');

describe('isAllowlisted', () => {
  const list = ['docwellness.fit@gmail.com'];
  it('matches exactly, case-insensitively', () => {
    expect(isAllowlisted('DocWellness.Fit@Gmail.com', list)).toBe(true);
  });
  it('rejects other addresses, including look-alikes and suffix matches', () => {
    expect(isAllowlisted('other@gmail.com', list)).toBe(false);
    expect(isAllowlisted('xdocwellness.fit@gmail.com', list)).toBe(false);
    expect(isAllowlisted('docwellness.fit@gmail.com.evil.com', list)).toBe(false);
  });
  it('rejects empty and non-string input', () => {
    expect(isAllowlisted('', list)).toBe(false);
    expect(isAllowlisted(undefined, list)).toBe(false);
    expect(isAllowlisted('docwellness.fit@gmail.com', [])).toBe(false);
  });
});

describe('evaluateSession', () => {
  const policy = { idleMinutes: 30, absoluteHours: 12 };
  const t0 = new Date('2026-10-12T10:00:00Z').getTime();
  const base = { startedAt: new Date(t0), lastSeenAt: new Date(t0) };

  it('is ok within limits', () => {
    expect(evaluateSession(base, t0 + 29 * 60000, policy)).toEqual({ ok: true });
  });
  it('expires after 30 idle minutes', () => {
    expect(evaluateSession(base, t0 + 31 * 60000, policy)).toEqual({ ok: false, reason: 'idle' });
  });
  it('expires after 12 hours even if active', () => {
    const active = { startedAt: new Date(t0), lastSeenAt: new Date(t0 + 12 * 3600000) };
    expect(evaluateSession(active, t0 + 12 * 3600000 + 60000, policy)).toEqual({
      ok: false,
      reason: 'absolute',
    });
  });
  it('rejects a revoked session', () => {
    expect(evaluateSession({ ...base, revokedAt: new Date() }, t0, policy)).toEqual({
      ok: false,
      reason: 'revoked',
    });
  });
});

describe('jwtClaim', () => {
  it('reads a claim and tolerates garbage', () => {
    const payload = Buffer.from(JSON.stringify({ session_id: 's1' })).toString('base64url');
    expect(jwtClaim(`h.${payload}.s`, 'session_id')).toBe('s1');
    expect(jwtClaim('not-a-jwt', 'session_id')).toBeUndefined();
  });
});

describe('default roles', () => {
  const role = (n) => DEFAULT_ROLES.find((r) => r.name === n);
  it('ships the six roles plus the reserved partner role', () => {
    expect(DEFAULT_ROLES.map((r) => r.name)).toEqual(
      expect.arrayContaining(['super_admin', 'support', 'finance', 'content', 'partnerships', 'viewer', 'partner'])
    );
    expect(role('partner').assignable).toBe(false);
  });
  it('finance cannot edit content; viewer is read-only', () => {
    expect(can(role('finance').permissions, 'content', 'edit')).toBe(false);
    for (const action of ['create', 'edit', 'delete', 'approve']) {
      expect(can(role('viewer').permissions, 'users', action)).toBe(false);
    }
    expect(can(role('viewer').permissions, 'users', 'view')).toBe(true);
  });
  it('super_admin can do everything', () => {
    expect(can(role('super_admin').permissions, 'audit', 'export')).toBe(true);
  });
});
