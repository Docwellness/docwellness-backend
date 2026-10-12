/**
 * adminAuth middleware (openspec add-admin-panel: admin-auth-access).
 * Dependencies are mocked so this exercises only the gate's decisions.
 */
jest.mock('../utils/supabaseAuth', () => ({ verifySupabaseToken: jest.fn() }));
jest.mock('../utils/adminAudit', () => ({ writeAudit: jest.fn().mockResolvedValue({}) }));
jest.mock('../models/User', () => ({ findOne: jest.fn(), create: jest.fn() }));
jest.mock('../models/Role', () => ({
  updateOne: jest.fn().mockResolvedValue({}),
  findOne: jest.fn(() => ({ lean: () => Promise.resolve({ permissions: { content: ['view', 'edit'] } }) })),
}));
jest.mock('../models/AdminSession', () => ({
  findOne: jest.fn(),
  create: jest.fn(),
  updateOne: jest.fn().mockResolvedValue({}),
}));

const { verifySupabaseToken } = require('../utils/supabaseAuth');
const { writeAudit } = require('../utils/adminAudit');
const User = require('../models/User');
const AdminSession = require('../models/AdminSession');
const { adminAuth, requirePermission } = require('../middlewares/adminAuth');

const tokenWith = (claims) =>
  `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;

const makeRes = () => {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
};
const makeReq = (token = tokenWith({ session_id: 'sess-1' })) => ({
  headers: { authorization: `Bearer ${token}`, 'user-agent': 'jest' },
  ip: '203.0.113.9',
});

const owner = {
  id: 'sb-1',
  email: 'docwellness.fit@gmail.com',
  email_confirmed_at: '2026-01-01T00:00:00Z',
  user_metadata: { full_name: 'Owner' },
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe('adminAuth', () => {
  it('rejects a request with no token', async () => {
    const res = makeRes();
    const next = jest.fn();
    await adminAuth({ headers: {} }, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects an invalid token', async () => {
    verifySupabaseToken.mockRejectedValue(new Error('bad'));
    const res = makeRes();
    const next = jest.fn();
    await adminAuth(makeReq(), res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('refuses a non-allowlisted Google account, records it, and creates no user', async () => {
    verifySupabaseToken.mockResolvedValue({ ...owner, email: 'someone@gmail.com' });
    const res = makeRes();
    const next = jest.fn();
    await adminAuth(makeReq(), res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(User.create).not.toHaveBeenCalled();
    expect(writeAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ outcome: 'denied', reason: 'email_not_allowlisted' })
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('refuses an unverified email even when it matches the allowlist', async () => {
    verifySupabaseToken.mockResolvedValue({ ...owner, email_confirmed_at: null, confirmed_at: null });
    const res = makeRes();
    await adminAuth(makeReq(), res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('refuses when the allowlisted email belongs to a non-admin account', async () => {
    verifySupabaseToken.mockResolvedValue(owner);
    User.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce({ role: 'dietician' });
    const res = makeRes();
    await adminAuth(makeReq(), res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'email_conflict' }));
  });

  it('creates the admin on first sign-in, starts a session and audits it', async () => {
    verifySupabaseToken.mockResolvedValue(owner);
    User.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    User.create.mockResolvedValue({ _id: 'u1', role: 'admin', profile: { fullName: 'Owner' } });
    AdminSession.findOne.mockResolvedValue(null);
    AdminSession.create.mockResolvedValue({ startedAt: new Date(), lastSeenAt: new Date() });
    const req = makeReq();
    const next = jest.fn();
    await adminAuth(req, makeRes(), next);
    expect(User.create).toHaveBeenCalledWith(expect.objectContaining({ role: 'admin', email: owner.email }));
    expect(next).toHaveBeenCalled();
    expect(req.admin.role).toBe('super_admin');
    expect(writeAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'admin.sign_in' }));
  });

  it('ends a session that has been idle for more than 30 minutes', async () => {
    verifySupabaseToken.mockResolvedValue(owner);
    User.findOne.mockResolvedValueOnce({ _id: 'u1', role: 'admin' });
    const old = new Date(Date.now() - 45 * 60000);
    AdminSession.findOne.mockResolvedValue({ _id: 's', startedAt: old, lastSeenAt: old });
    const res = makeRes();
    const next = jest.fn();
    await adminAuth(makeReq(), res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'session_expired' }));
    expect(AdminSession.updateOne).toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects an explicitly revoked session', async () => {
    verifySupabaseToken.mockResolvedValue(owner);
    User.findOne.mockResolvedValueOnce({ _id: 'u1', role: 'admin' });
    AdminSession.findOne.mockResolvedValue({
      _id: 's',
      startedAt: new Date(),
      lastSeenAt: new Date(),
      revokedAt: new Date(),
    });
    const res = makeRes();
    await adminAuth(makeReq(), res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(401);
  });
});

describe('requirePermission', () => {
  it('allows a granted action and denies everything else', () => {
    const guard = requirePermission('content', 'edit');
    const next = jest.fn();
    guard({ admin: { permissions: { content: ['view', 'edit'] } } }, makeRes(), next);
    expect(next).toHaveBeenCalled();

    const res = makeRes();
    const denied = jest.fn();
    requirePermission('payments', 'approve')({ admin: { permissions: { content: ['edit'] } } }, res, denied);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(denied).not.toHaveBeenCalled();
  });

  it('denies when there is no admin context at all', () => {
    const res = makeRes();
    requirePermission('content', 'view')({}, res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(403);
  });
});
