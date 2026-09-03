/**
 * Manual Jest mock for utils/supabaseAuth.js - AI_EXECUTION_PLAN.md Phase 8,
 * P8-01. Real login happens against Supabase directly (client-side SDK, no
 * backend endpoint - see auth_controller.dart on the Flutter side); the
 * backend's own job is verifying a Supabase-issued token and resolving it
 * to a linked Mongo User (see the real utils/supabaseAuth.js). Testing
 * against a live Supabase project isn't practical or desirable for an
 * integration test, so this mocks exactly that boundary - a fake token
 * registry standing in for Supabase's own verification - while every test
 * downstream of it (role checks, ownership checks, route behavior) runs
 * against the real middleware and real database.
 *
 * Picked up automatically by `jest.mock('../../utils/supabaseAuth')`
 * (no factory needed) in any test file under tests/ that requires it.
 */

const tokenToUserId = new Map();
// email -> { password, session } - controls signInWithPassword (P9-B2 tests).
const credentials = new Map();
// refreshToken -> session - controls refreshSession (P9-B3 tests).
const refreshTokens = new Map();
let refreshCallCount = 0;
// Small artificial delay so two near-simultaneous refresh requests in a
// dedup test reliably overlap in utils/refreshDedup.js's in-flight map,
// instead of the first one resolving before the second's request handler
// even starts (supertest's HTTP round-trip is otherwise fast enough that
// they wouldn't reproduce the race being tested).
const REFRESH_DELAY_MS = 25;

function registerTestToken(token, userId) {
  tokenToUserId.set(token, userId.toString());
}

/**
 * Makes `signInWithPassword(email, password)` succeed with `session` for
 * this exact email/password pair - any other password for that email (or
 * an unregistered email) rejects, same as the real Supabase call would for
 * wrong credentials. Used by tests/loginLockout.test.js (P9-B2).
 */
function registerTestCredentials(email, password, session) {
  credentials.set(email.toLowerCase(), { password, session });
}

/**
 * Makes `refreshSession(refreshToken)` succeed with `session` for this
 * exact token. Used by tests/loginLockout.test.js's refresh-dedup coverage
 * (P9-B3) to assert the underlying Supabase call only happens once for
 * concurrent callers.
 */
function registerTestRefreshToken(refreshToken, session) {
  refreshTokens.set(refreshToken, session);
}

function clearTestTokens() {
  tokenToUserId.clear();
  credentials.clear();
  refreshTokens.clear();
  refreshCallCount = 0;
}

/** How many times the underlying refreshSession() mock actually ran. */
function getRefreshCallCount() {
  return refreshCallCount;
}

async function getUserFromSupabaseToken(token) {
  const userId = tokenToUserId.get(token);
  if (!userId) {
    const err = new Error('Invalid or expired token');
    err.code = 'invalid_token';
    throw err;
  }
  // Required lazily so this mock file has no load-order dependency on
  // models/index.js - mirrors the real supabaseAuth.js's own approach.
  // eslint-disable-next-line global-require
  const { User } = require('../../models');
  const user = await User.findById(userId);
  if (!user) {
    const err = new Error('No profile linked to this account yet');
    err.code = 'no_profile';
    throw err;
  }
  // Mirror the real module's deactivated-account gate so integration tests
  // can register a token for a user and then deactivate them.
  if (user.isActive === false) {
    const err = new Error('This account has been deactivated');
    err.code = 'account_disabled';
    throw err;
  }
  return user;
}

async function verifySupabaseToken() {
  throw new Error(
    'verifySupabaseToken is not mocked - none of the P8-01 integration tests exercise the registration-completion path that uses it'
  );
}

async function signInWithPassword(email, password) {
  const entry = credentials.get(email.toLowerCase());
  if (!entry || entry.password !== password) {
    const err = new Error('Invalid email or password');
    err.code = 'invalid_credentials';
    throw err;
  }
  return entry.session;
}

async function refreshSession(refreshToken) {
  refreshCallCount += 1;
  await new Promise((resolve) => setTimeout(resolve, REFRESH_DELAY_MS));
  const session = refreshTokens.get(refreshToken);
  if (!session) {
    const err = new Error('Session expired, please log in again');
    err.code = 'invalid_refresh_token';
    throw err;
  }
  return session;
}

module.exports = {
  getUserFromSupabaseToken,
  verifySupabaseToken,
  signInWithPassword,
  refreshSession,
  registerTestToken,
  registerTestCredentials,
  registerTestRefreshToken,
  clearTestTokens,
  getRefreshCallCount,
};
