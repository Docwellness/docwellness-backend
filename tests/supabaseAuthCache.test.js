/**
 * getUserFromSupabaseToken end-to-end with the token->user cache ON
 * (cross-app performance optimization, Phase 2, task 2.5).
 *
 * Proves the cache removes the Supabase network round trip on repeat calls,
 * still re-reads the Mongo User every time, and is dropped on logout.
 *
 * NOTE: this file does NOT `jest.mock('../utils/supabaseAuth')` - it
 * exercises the real module, mocking only its two boundaries: the Supabase
 * client and Redis. (mock-prefixed names so jest.mock factories may close
 * over them.)
 */

const { connectTestDb, disconnectTestDb, clearTestDb } = require('./helpers/testDb');

// --- in-memory Redis stand-in ---
const mockStore = new Map();
const mockRedis = {
  async get(k) {
    const e = mockStore.get(k);
    if (!e) return null;
    if (e.expiresAt && Date.now() > e.expiresAt) {
      mockStore.delete(k);
      return null;
    }
    return e.value;
  },
  async set(k, v, mode, s) {
    mockStore.set(k, {
      value: v,
      expiresAt: mode === 'EX' ? Date.now() + s * 1000 : null,
    });
    return 'OK';
  },
  async del(k) {
    return mockStore.delete(k) ? 1 : 0;
  },
};
jest.mock('../utils/redisClient', () => ({ client: mockRedis, isEnabled: true }));

// --- Supabase client stand-in ---
const mockState = { getUserCalls: 0, supabaseUserId: 'sb-abc-123' };
const mockSupabase = {
  auth: {
    getUser: jest.fn(async () => {
      mockState.getUserCalls += 1;
      return {
        data: { user: { id: mockState.supabaseUserId, email: 'u@example.test' } },
        error: null,
      };
    }),
    admin: { signOut: jest.fn(async () => ({ error: null })) },
  },
};
jest.mock('@supabase/supabase-js', () => ({ createClient: () => mockSupabase }));

let User;
let getUserFromSupabaseToken;
let signOutSession;

/** Fake JWT with a far-future exp so the cache-TTL cap uses 90s. */
const token = () => {
  const payload = Buffer.from(
    JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })
  ).toString('base64');
  return `h.${payload}.s`;
};

beforeAll(async () => {
  await connectTestDb();
  ({ User } = require('../models'));
  ({ getUserFromSupabaseToken, signOutSession } = require('../utils/supabaseAuth'));
});

afterEach(async () => {
  mockStore.clear();
  mockState.getUserCalls = 0;
  mockState.supabaseUserId = 'sb-abc-123';
  mockSupabase.auth.getUser.mockClear();
  mockSupabase.auth.admin.signOut.mockClear();
  await clearTestDb();
});

afterAll(async () => {
  await disconnectTestDb();
});

const seedUser = (extra = {}) =>
  User.create({
    supabaseUserId: mockState.supabaseUserId,
    email: 'u@example.test',
    role: 'patient',
    profile: { fullName: 'Cache User' },
    healthProfile: { bmi: 22, weightIndex: 0 },
    ...extra,
  });

describe('getUserFromSupabaseToken + token cache', () => {
  test('second call within the window resolves from cache (no extra Supabase call)', async () => {
    await seedUser();
    const t = token();

    const first = await getUserFromSupabaseToken(t);
    const second = await getUserFromSupabaseToken(t);

    expect(first._id.toString()).toBe(second._id.toString());
    expect(mockState.getUserCalls).toBe(1);
  });

  test('the Mongo User is still re-read on a cache hit (role is never cached)', async () => {
    const user = await seedUser({ role: 'patient' });
    const t = token();
    await getUserFromSupabaseToken(t);

    await User.updateOne({ _id: user._id }, { role: 'dietician' });
    const resolved = await getUserFromSupabaseToken(t);

    expect(mockState.getUserCalls).toBe(1);
    expect(resolved.role).toBe('dietician');
  });

  test('logout (signOutSession global) drops the cache entry', async () => {
    await seedUser();
    const t = token();
    await getUserFromSupabaseToken(t);
    expect(mockState.getUserCalls).toBe(1);

    await signOutSession(t, 'global');

    await getUserFromSupabaseToken(t);
    expect(mockState.getUserCalls).toBe(2);
  });

  test("changePassword's signOutSession('others') leaves the caller's cache intact", async () => {
    await seedUser();
    const t = token();
    await getUserFromSupabaseToken(t);
    await signOutSession(t, 'others');
    await getUserFromSupabaseToken(t);
    expect(mockState.getUserCalls).toBe(1);
  });

  test('a cached id that no longer resolves to a profile falls through to full verify', async () => {
    await seedUser();
    const t = token();
    await getUserFromSupabaseToken(t);

    await User.deleteMany({});

    await expect(getUserFromSupabaseToken(t)).rejects.toMatchObject({ code: 'no_profile' });
    expect(mockState.getUserCalls).toBe(2);
  });
});

describe('deactivated-account gate', () => {
  test('a user with isActive:false is rejected (cache cold - full verify path)', async () => {
    await seedUser({ isActive: false });
    await expect(getUserFromSupabaseToken(token())).rejects.toMatchObject({
      code: 'account_disabled',
    });
  });

  test('deactivating a user takes effect on the next request even on a cache hit', async () => {
    const user = await seedUser();
    const t = token();

    // First call warms the token->id cache.
    await getUserFromSupabaseToken(t);
    expect(mockState.getUserCalls).toBe(1);

    await User.updateOne({ _id: user._id }, { isActive: false });

    // Cache hit (no extra Supabase call), but the Mongo re-read sees isActive:false.
    await expect(getUserFromSupabaseToken(t)).rejects.toMatchObject({ code: 'account_disabled' });
    expect(mockState.getUserCalls).toBe(1);

    // Reactivating restores access, still from cache.
    await User.updateOne({ _id: user._id }, { isActive: true });
    const resolved = await getUserFromSupabaseToken(t);
    expect(resolved._id.toString()).toBe(user._id.toString());
    expect(mockState.getUserCalls).toBe(1);
  });

  test("a blocked account's token is not cached", async () => {
    await seedUser({ isActive: false });
    const t = token();
    await expect(getUserFromSupabaseToken(t)).rejects.toMatchObject({ code: 'account_disabled' });
    // No token->id entry was written (setCachedUserId is skipped before the throw).
    expect([...mockStore.keys()].some((k) => k.startsWith('authtok:'))).toBe(false);
  });
});
