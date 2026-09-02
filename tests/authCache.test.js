/**
 * utils/authCache + its use in getUserFromSupabaseToken - cross-app
 * performance optimization, Phase 2 (task 2.5).
 */

// A tiny in-memory Redis stand-in. Supports exactly what authCache.js uses:
// get(key), set(key, val, 'EX', seconds), del(key).
const store = new Map(); // key -> { value, expiresAt }
const fakeRedis = {
  async get(key) {
    const e = store.get(key);
    if (!e) return null;
    if (e.expiresAt && Date.now() > e.expiresAt) {
      store.delete(key);
      return null;
    }
    return e.value;
  },
  async set(key, value, mode, seconds) {
    const expiresAt = mode === 'EX' ? Date.now() + seconds * 1000 : null;
    store.set(key, { value, expiresAt });
    return 'OK';
  },
  async del(key) {
    return store.delete(key) ? 1 : 0;
  },
  // captured so a test can assert the TTL passed to set()
  _lastSet: null,
};
const setSpy = jest.spyOn(fakeRedis, 'set');

jest.mock('../utils/redisClient', () => ({ client: fakeRedis, isEnabled: true }));

const {
  getCachedUserId,
  setCachedUserId,
  invalidateToken,
  jwtExpSeconds,
} = require('../utils/authCache');

/** Builds a fake JWT whose payload carries `exp` (epoch seconds). */
function tokenWithExp(expSeconds) {
  const payload = Buffer.from(JSON.stringify({ exp: expSeconds })).toString('base64');
  return `hdr.${payload}.sig`;
}

const crypto = require('crypto');
const keyForToken = (t) =>
  `authtok:${crypto.createHash('sha256').update(t).digest('hex')}`;

afterEach(() => {
  store.clear();
  setSpy.mockClear();
});

describe('utils/authCache', () => {
  test('jwtExpSeconds reads the exp claim, null on garbage', () => {
    expect(jwtExpSeconds(tokenWithExp(1893456000))).toBe(1893456000);
    expect(jwtExpSeconds('not-a-jwt')).toBeNull();
    expect(jwtExpSeconds('')).toBeNull();
  });

  test('set then get round-trips the supabaseUserId', async () => {
    const token = tokenWithExp(Math.floor(Date.now() / 1000) + 3600);
    await setCachedUserId(token, 'sb-user-1');
    expect(await getCachedUserId(token)).toBe('sb-user-1');
  });

  test('TTL is capped at min(90s, exp - now)', async () => {
    const near = tokenWithExp(Math.floor(Date.now() / 1000) + 30); // ~30s left
    await setCachedUserId(near, 'sb-user-2');
    const nearTtl = setSpy.mock.calls[0][3];
    expect(nearTtl).toBeGreaterThanOrEqual(28);
    expect(nearTtl).toBeLessThanOrEqual(30);

    setSpy.mockClear();
    const far = tokenWithExp(Math.floor(Date.now() / 1000) + 3600); // > 90s left
    await setCachedUserId(far, 'sb-user-3');
    expect(setSpy).toHaveBeenCalledWith(expect.any(String), 'sb-user-3', 'EX', 90);
  });

  test('getCachedUserId short-circuits to null for a token past its own exp, even if cached', async () => {
    const expired = tokenWithExp(Math.floor(Date.now() / 1000) - 5);
    // Force an entry under that token's key, then confirm the exp check
    // wins over the cache hit.
    await setCachedUserId(
      tokenWithExp(Math.floor(Date.now() / 1000) + 3600),
      'ignored'
    );
    store.set(
      keyForToken(expired),
      { value: 'sb-user-4', expiresAt: Date.now() + 90_000 }
    );
    expect(await getCachedUserId(expired)).toBeNull();
  });

  test('a token with no parseable exp still caches (capped at 90s) and reads back', async () => {
    const token = 'opaque-token-no-jwt-shape';
    await setCachedUserId(token, 'sb-user-5');
    expect(setSpy).toHaveBeenCalledWith(expect.any(String), 'sb-user-5', 'EX', 90);
    expect(await getCachedUserId(token)).toBe('sb-user-5');
  });

  test('invalidateToken drops the entry', async () => {
    const token = tokenWithExp(Math.floor(Date.now() / 1000) + 3600);
    await setCachedUserId(token, 'sb-user-6');
    await invalidateToken(token);
    expect(await getCachedUserId(token)).toBeNull();
  });

  test('the redis key never contains the raw token', async () => {
    const token = tokenWithExp(Math.floor(Date.now() / 1000) + 3600);
    await setCachedUserId(token, 'sb-user-7');
    for (const key of store.keys()) {
      expect(key).not.toContain(token);
      expect(key).toMatch(/^authtok:[0-9a-f]{64}$/);
    }
  });
});

describe('utils/authCache disabled (no REDIS_URL)', () => {
  test('every operation is a silent no-op', async () => {
    jest.resetModules();
    jest.doMock('../utils/redisClient', () => ({ client: null, isEnabled: false }));
    const disabled = require('../utils/authCache');
    const token = tokenWithExp(Math.floor(Date.now() / 1000) + 3600);
    await expect(disabled.setCachedUserId(token, 'x')).resolves.toBeUndefined();
    await expect(disabled.getCachedUserId(token)).resolves.toBeNull();
    await expect(disabled.invalidateToken(token)).resolves.toBeUndefined();
    jest.dontMock('../utils/redisClient');
    jest.resetModules();
  });
});
