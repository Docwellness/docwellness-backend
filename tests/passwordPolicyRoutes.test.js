/**
 * Password policy wired into the auth routes (auth-spec-audit follow-up #3).
 * signup-request and reset-password reject a weak password with 400 /
 * code 'weak_password' before touching Supabase; a strong one proceeds.
 * (change-password uses the identical `passwordPolicyError` helper - its
 * strength logic is covered by tests/passwordPolicy.test.js.)
 */

// HIBP check: stub fetch so tests never hit the network. Default = not breached.
const realFetch = global.fetch;
const mockFetch = jest.fn(async () => ({ ok: true, text: async () => 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA:1' }));
global.fetch = mockFetch;
afterAll(() => {
  global.fetch = realFetch;
});

jest.mock('../utils/emailService', () => ({
  sendSignupOtp: jest.fn(async () => ({ queued: true })),
  sendPasswordResetOtp: jest.fn(async () => ({ queued: true })),
  sendWelcomeEmail: jest.fn(async () => ({ queued: true })),
}));

const { connectTestDb, disconnectTestDb, clearTestDb } = require('./helpers/testDb');

jest.mock('../utils/supabaseAuth');
const { clearTestTokens } = require('../utils/supabaseAuth');

let request;
let app;

beforeAll(async () => {
  await connectTestDb();
  request = require('supertest');
  app = require('../config/createApp')();
});

afterEach(async () => {
  mockFetch.mockClear();
  clearTestTokens();
  await clearTestDb();
});

afterAll(async () => {
  await disconnectTestDb();
});

const STRONG = 'Correct-Horse-9Battery';

describe('POST /api/patient/auth/signup-request', () => {
  test('rejects a short password with 400 / weak_password', async () => {
    const res = await request(app)
      .post('/api/patient/auth/signup-request')
      .send({ email: 'newuser@example.test', password: 'short1!' });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ success: false, code: 'weak_password' });
    expect(res.body.message).toMatch(/at least 12/);
  });

  test('rejects a password containing the email local-part', async () => {
    const res = await request(app)
      .post('/api/patient/auth/signup-request')
      .send({ email: 'priya.k@example.test', password: 'priya.k-Str0ng!' });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/email address/);
  });

  test('rejects a password flagged by the HIBP breach check', async () => {
    const crypto = require('crypto');
    const sha1 = crypto.createHash('sha1').update(STRONG).digest('hex').toUpperCase();
    mockFetch.mockResolvedValueOnce({ ok: true, text: async () => `${sha1.slice(5)}:42` });

    const res = await request(app)
      .post('/api/patient/auth/signup-request')
      .send({ email: 'newuser@example.test', password: STRONG });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/data breach/);
  });

  test('a strong, unbreached password proceeds (200)', async () => {
    const res = await request(app)
      .post('/api/patient/auth/signup-request')
      .send({ email: 'newuser@example.test', password: STRONG });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

describe('POST /api/patient/auth/reset-password', () => {
  test('rejects a weak new password with 400 / weak_password before verifying the code', async () => {
    const res = await request(app)
      .post('/api/patient/auth/reset-password')
      .send({ email: 'someone@example.test', code: '000000', newPassword: 'weak' });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'weak_password' });
  });

  test('a strong new password reaches the (mocked) reset step', async () => {
    const res = await request(app)
      .post('/api/patient/auth/reset-password')
      .send({ email: 'someone@example.test', code: '123456', newPassword: STRONG });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});
