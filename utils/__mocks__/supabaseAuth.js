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

function registerTestToken(token, userId) {
  tokenToUserId.set(token, userId.toString());
}

function clearTestTokens() {
  tokenToUserId.clear();
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
  return user;
}

async function verifySupabaseToken() {
  throw new Error(
    'verifySupabaseToken is not mocked - none of the P8-01 integration tests exercise the registration-completion path that uses it'
  );
}

module.exports = {
  getUserFromSupabaseToken,
  verifySupabaseToken,
  registerTestToken,
  clearTestTokens,
};
