/**
 * AI_EXECUTION_PLAN.md Phase 9 - login lockout (P9-B2) and concurrent
 * refresh de-duplication (P9-B3).
 */

const { connectTestDb, disconnectTestDb, clearTestDb } = require('./helpers/testDb');

jest.mock('../utils/supabaseAuth');
const {
  registerTestCredentials,
  registerTestRefreshToken,
  clearTestTokens,
  getRefreshCallCount,
} = require('../utils/supabaseAuth');
const { _resetForTests: resetLockoutState } = require('../utils/loginLockout');

let request;
let app;

beforeAll(async () => {
  await connectTestDb();
  request = require('supertest');
  app = require('../config/createApp')();
});

afterEach(async () => {
  clearTestTokens();
  resetLockoutState();
  await clearTestDb();
});

afterAll(async () => {
  await disconnectTestDb();
});

function fakeSession(accessToken = 'access-token') {
  return {
    access_token: accessToken,
    refresh_token: 'refresh-token',
    expires_at: Math.floor(Date.now() / 1000) + 900,
  };
}

describe('login lockout (P9-B2)', () => {
  test('locks patient login after 5 failed attempts, with a random retryAfter between 60 and 300', async () => {
    registerTestCredentials('patient@example.test', 'correct-password', fakeSession());

    for (let i = 0; i < 4; i += 1) {
      const res = await request(app)
        .post('/api/patient/auth/login')
        .send({ email: 'patient@example.test', password: 'wrong-password' });
      expect(res.status).toBe(401);
    }

    const lockingRes = await request(app)
      .post('/api/patient/auth/login')
      .send({ email: 'patient@example.test', password: 'wrong-password' });

    expect(lockingRes.status).toBe(429);
    expect(lockingRes.body.retryAfter).toBeGreaterThanOrEqual(60);
    expect(lockingRes.body.retryAfter).toBeLessThanOrEqual(300);
    expect(lockingRes.headers['retry-after']).toBe(String(lockingRes.body.retryAfter));

    // Still locked even with the correct password now.
    const stillLockedRes = await request(app)
      .post('/api/patient/auth/login')
      .send({ email: 'patient@example.test', password: 'correct-password' });
    expect(stillLockedRes.status).toBe(429);
  });

  test('locks dietician login after only 3 failed attempts (stricter threshold)', async () => {
    for (let i = 0; i < 2; i += 1) {
      const res = await request(app)
        .post('/api/dietician/auth/login')
        .send({ email: 'dietician@example.test', password: 'wrong-password' });
      expect(res.status).toBe(401);
    }

    const lockingRes = await request(app)
      .post('/api/dietician/auth/login')
      .send({ email: 'dietician@example.test', password: 'wrong-password' });

    expect(lockingRes.status).toBe(429);
    expect(lockingRes.body.retryAfter).toBeGreaterThanOrEqual(60);
    expect(lockingRes.body.retryAfter).toBeLessThanOrEqual(300);
  });

  test('a patient lockout does not affect the same email logging in as a dietician', async () => {
    for (let i = 0; i < 3; i += 1) {
      await request(app)
        .post('/api/dietician/auth/login')
        .send({ email: 'shared@example.test', password: 'wrong-password' });
    }
    const dieticianLocked = await request(app)
      .post('/api/dietician/auth/login')
      .send({ email: 'shared@example.test', password: 'wrong-password' });
    expect(dieticianLocked.status).toBe(429);

    registerTestCredentials('shared@example.test', 'correct-password', fakeSession());
    const patientRes = await request(app)
      .post('/api/patient/auth/login')
      .send({ email: 'shared@example.test', password: 'correct-password' });
    expect(patientRes.status).toBe(200);
  });

  test('a successful login clears the failed-attempt counter', async () => {
    registerTestCredentials('patient2@example.test', 'correct-password', fakeSession());

    for (let i = 0; i < 4; i += 1) {
      await request(app)
        .post('/api/patient/auth/login')
        .send({ email: 'patient2@example.test', password: 'wrong-password' });
    }

    const successRes = await request(app)
      .post('/api/patient/auth/login')
      .send({ email: 'patient2@example.test', password: 'correct-password' });
    expect(successRes.status).toBe(200);

    // Counter reset - another 4 failures shouldn't lock (would need a 5th).
    for (let i = 0; i < 4; i += 1) {
      const res = await request(app)
        .post('/api/patient/auth/login')
        .send({ email: 'patient2@example.test', password: 'wrong-password' });
      expect(res.status).toBe(401);
    }
  });

  test('blocks dietician login from a device reporting jailbreak, without counting toward the lockout', async () => {
    const res = await request(app)
      .post('/api/dietician/auth/login')
      .set('X-Jailbreak-Detected', 'true')
      .send({ email: 'jailbroken@example.test', password: 'wrong-password' });

    expect(res.status).toBe(403);
  });
});

describe('refresh de-duplication (P9-B3)', () => {
  test('concurrent requests with the same refresh token only hit Supabase once', async () => {
    registerTestRefreshToken('same-refresh-token', fakeSession('rotated-access-token'));

    const [resA, resB] = await Promise.all([
      request(app).post('/api/patient/auth/refresh').send({ refreshToken: 'same-refresh-token' }),
      request(app).post('/api/patient/auth/refresh').send({ refreshToken: 'same-refresh-token' }),
    ]);

    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);
    expect(resA.body.data.accessToken).toBe('rotated-access-token');
    expect(resB.body.data.accessToken).toBe('rotated-access-token');
    expect(getRefreshCallCount()).toBe(1);
  });

  test('different refresh tokens are not deduplicated against each other', async () => {
    registerTestRefreshToken('token-a', fakeSession('access-a'));
    registerTestRefreshToken('token-b', fakeSession('access-b'));

    const [resA, resB] = await Promise.all([
      request(app).post('/api/patient/auth/refresh').send({ refreshToken: 'token-a' }),
      request(app).post('/api/patient/auth/refresh').send({ refreshToken: 'token-b' }),
    ]);

    expect(resA.body.data.accessToken).toBe('access-a');
    expect(resB.body.data.accessToken).toBe('access-b');
    expect(getRefreshCallCount()).toBe(2);
  });
});
