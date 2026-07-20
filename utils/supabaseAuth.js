const { createClient } = require('@supabase/supabase-js');
const config = require('../config/environment');
const { User } = require('../models');

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

module.exports = {
  getSupabaseAdmin,
  verifySupabaseToken,
  getUserFromSupabaseToken,
  verifyPassword,
  generateRecoveryOtp,
  generateSignupOtp,
};
