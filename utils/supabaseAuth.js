const { createClient } = require('@supabase/supabase-js');
const config = require('../config/environment');
const { User } = require('../models');

// @supabase/supabase-js's admin API (auth.admin.*) pulls in realtime-js,
// which expects a native `WebSocket` global - only present in Node 22+.
// Prod runs Node 20 (see Dockerfile: node:20-slim), where this throws
// "Node.js detected but native WebSocket not found" the first time any
// auth.admin.* method is called (createUser, updateUserById,
// generateLink, signOut - i.e. signup, password reset/change, and account
// deletion all go through this). Non-admin methods (signInWithPassword,
// verifyOtp, refreshSession) never hit this path, which is why it stayed
// undiscovered until the first real admin-API call against this
// container. `ws` is already a real dependency (see package.json), not a
// bare devDependency-only polyfill.
if (typeof WebSocket === 'undefined') {
  global.WebSocket = require('ws');
}

// Constructed lazily (not at module load) for the same reason as the Resend
// client: this file is required by middlewares/auth.js and both Socket.IO
// gateways unconditionally, so a missing env var shouldn't crash app
// startup, only actual auth attempts.
let client;
const getSupabaseAdmin = () => {
  if (!client) {
    client = createClient(config.supabase.url, config.supabase.serviceRoleKey);
  }
  return client;
};

/**
 * Verifies a Supabase access token and returns the raw Supabase user
 * ({ id, email, ... }) - no Mongo lookup. Used where a linked Mongo User
 * isn't expected to exist yet (e.g. the registration-completion endpoint).
 */
async function verifySupabaseToken(token) {
  const { data, error } = await getSupabaseAdmin().auth.getUser(token);
  if (error || !data?.user) {
    const err = new Error('Invalid or expired token');
    err.code = 'invalid_token';
    throw err;
  }
  return data.user;
}

/**
 * Verifies a Supabase access token and returns the linked Mongo `User`
 * document (same shape every controller already expects on req.user).
 * Throws with a distinguishable `.code` on failure:
 *   - 'invalid_token'  the token itself is invalid/expired
 *   - 'no_profile'     the Supabase account exists but registration was
 *                       never completed (no linked Mongo User yet)
 */
async function getUserFromSupabaseToken(token) {
  const supabaseUser = await verifySupabaseToken(token);

  const user = await User.findOne({ supabaseUserId: supabaseUser.id });
  if (!user) {
    const err = new Error('No profile linked to this account yet');
    err.code = 'no_profile';
    throw err;
  }

  return user;
}

/**
 * Verifies a password against Supabase (used for password-confirmation
 * flows like account deletion). Returns true/false, never throws for a
 * simple wrong-password case.
 */
async function verifyPassword(email, password) {
  const { error } = await getSupabaseAdmin().auth.signInWithPassword({ email, password });
  return !error;
}

/**
 * Generates a password-recovery OTP code for an email via Supabase's admin
 * API, without sending anything (Supabase's own email templates are never
 * used - the caller is responsible for delivering the code, e.g. via
 * Resend). Returns null if the email isn't a Supabase user rather than
 * throwing, so callers can respond generically without leaking which
 * emails are registered.
 */
async function generateRecoveryOtp(email) {
  const { data, error } = await getSupabaseAdmin().auth.admin.generateLink({
    type: 'recovery',
    email,
  });
  if (error) return null;
  return data.properties.email_otp;
}

/**
 * Creates a new Supabase identity (unconfirmed) and returns a signup OTP
 * code for it, via the same admin.generateLink approach as recovery -
 * again, Supabase's own signup email is never triggered, we deliver the
 * code ourselves (via Resend). Throws with `.code = 'email_taken'` if a
 * Supabase user already exists for this email.
 */
async function generateSignupOtp(email, password) {
  const { data, error } = await getSupabaseAdmin().auth.admin.generateLink({
    type: 'signup',
    email,
    password,
  });
  if (error) {
    const err = new Error(error.message);
    err.code = error.code === 'email_exists' ? 'email_taken' : 'signup_failed';
    throw err;
  }
  return data.properties.email_otp;
}

/**
 * Signs in with email/password and returns the resulting Supabase session
 * (access token, refresh token, expiry) - the server-side equivalent of the
 * client calling supabase.auth.signInWithPassword() directly. Unlike
 * verifyPassword above (which discards the session, used only as a yes/no
 * confirmation), this is the real login path: the caller needs the tokens.
 * Throws with the raw Supabase error message on failure (invalid
 * credentials, etc.) - callers should surface a generic message rather than
 * this raw one, to avoid distinguishing "wrong email" from "wrong password".
 */
async function signInWithPassword(email, password) {
  const { data, error } = await getSupabaseAdmin().auth.signInWithPassword({ email, password });
  if (error || !data?.session) {
    const err = new Error(error?.message || 'Invalid email or password');
    err.code = 'invalid_credentials';
    throw err;
  }
  return data.session;
}

/**
 * Verifies a signup OTP code (see generateSignupOtp above - the code this
 * verifies against) and returns the resulting session. Server-side
 * equivalent of the client calling supabase.auth.verifyOtp(type: 'signup')
 * directly - the register endpoint downstream doesn't care how the caller
 * obtained a valid Supabase access token, so nothing else about the signup
 * flow changes.
 */
async function verifySignupOtp(email, code) {
  const { data, error } = await getSupabaseAdmin().auth.verifyOtp({
    email,
    token: code,
    type: 'signup',
  });
  if (error || !data?.session) {
    const err = new Error(error?.message || 'Invalid or expired code');
    err.code = 'invalid_otp';
    throw err;
  }
  return data.session;
}

/**
 * Verifies a password-recovery OTP (see generateRecoveryOtp above) and, if
 * valid, sets the account's new password directly via the admin API -
 * combining what used to be three separate client-side Supabase calls
 * (verifyOtp -> updateUser -> signOut) into one server call. No session is
 * returned or needed: the client sends the user back to the login screen
 * afterward either way, so there's nothing to hand back but success/failure.
 */
async function resetPasswordWithOtp(email, code, newPassword) {
  const { data, error } = await getSupabaseAdmin().auth.verifyOtp({
    email,
    token: code,
    type: 'recovery',
  });
  if (error || !data?.user) {
    const err = new Error(error?.message || 'Invalid or expired code');
    err.code = 'invalid_otp';
    throw err;
  }

  const { error: updateError } = await getSupabaseAdmin().auth.admin.updateUserById(data.user.id, {
    password: newPassword,
  });
  if (updateError) {
    throw new Error(updateError.message || 'Could not reset password');
  }
}

/**
 * Exchanges a refresh token for a new session - server-side equivalent of
 * the client's supabase.auth.refreshSession(), now that the app no longer
 * runs the Supabase SDK's own background auto-refresh timer (see
 * lib/utils/functions/dio_function.dart's ApiService.request() on the
 * Flutter side, which calls this proactively before an expiring request).
 */
async function refreshSession(refreshToken) {
  const { data, error } = await getSupabaseAdmin().auth.refreshSession({
    refresh_token: refreshToken,
  });
  if (error || !data?.session) {
    const err = new Error(error?.message || 'Session expired, please log in again');
    err.code = 'invalid_refresh_token';
    throw err;
  }
  return data.session;
}

/**
 * Revokes a session via the admin API - 'global' actually invalidates the
 * caller's own token (real logout, replacing the old client-side
 * supabase.auth.signOut()); 'others' revokes every *other* session tied to
 * the same account while leaving the caller's own current session intact
 * (the change-password "sign out everywhere else" step, replacing
 * supabase.auth.signOut(scope: SignOutScope.others)).
 */
async function signOutSession(accessToken, scope) {
  const { error } = await getSupabaseAdmin().auth.admin.signOut(accessToken, scope);
  if (error) {
    console.error(`signOutSession (scope=${scope}) failed:`, error.message);
  }
}

module.exports = {
  getSupabaseAdmin,
  verifySupabaseToken,
  getUserFromSupabaseToken,
  verifyPassword,
  generateRecoveryOtp,
  generateSignupOtp,
  signInWithPassword,
  verifySignupOtp,
  resetPasswordWithOtp,
  refreshSession,
  signOutSession,
};
