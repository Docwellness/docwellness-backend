/**
 * Server-side password policy (auth-spec-audit follow-up #3), applied on
 * signup, password reset, and password change. Supabase only enforces a
 * short default minimum length, so the real rules live here.
 *
 * Deliberately NOT included: zxcvbn (a ~400KB dependency - the length +
 * character-class + identity + breach checks below cover the same intent
 * for this app's threat model), and password history / rotation (needs
 * storage Supabase doesn't expose - see the audit).
 */

const crypto = require('crypto');

const MIN_LENGTH = 12;
const MAX_LENGTH = 128; // bcrypt truncates at 72 bytes anyway; this just bounds abuse

/**
 * Synchronous strength checks. Returns a user-facing error string, or null
 * when the password passes.
 * @param {string} password
 * @param {{ email?: string, name?: string }} [context]
 */
function validatePasswordStrength(password, { email, name } = {}) {
  if (typeof password !== 'string' || password.length < MIN_LENGTH) {
    return `Password must be at least ${MIN_LENGTH} characters long.`;
  }
  if (password.length > MAX_LENGTH) {
    return `Password must be at most ${MAX_LENGTH} characters long.`;
  }

  const classCount = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) =>
    re.test(password)
  ).length;
  if (classCount < 3) {
    return 'Password must include at least three of: a lowercase letter, an uppercase letter, a number, and a symbol.';
  }

  // A short unit repeated to fill the length ("Ab1!Ab1!Ab1!", "abcabcabcabc")
  // can pass the length + class checks while carrying almost no entropy.
  if (/^(.{1,4})\1+$/.test(password)) {
    return 'Password is too simple - avoid repeating a short sequence.';
  }

  const lower = password.toLowerCase();

  if (email) {
    const localPart = String(email).split('@')[0].toLowerCase();
    if (localPart.length >= 3 && lower.includes(localPart)) {
      return 'Password must not contain your email address.';
    }
  }

  if (name) {
    const parts = String(name)
      .toLowerCase()
      .split(/[\s.,'-]+/)
      .filter((p) => p.length >= 3);
    if (parts.some((p) => lower.includes(p))) {
      return 'Password must not contain your name.';
    }
  }

  return null;
}

/**
 * HIBP "Pwned Passwords" range API, k-anonymity model: only the first 5
 * hex chars of the SHA-1 hash are sent. Best-effort - any network / API
 * failure resolves to `false` (treat as not-breached) rather than blocking
 * a legitimate password change on a third-party outage.
 * @param {string} password
 * @returns {Promise<boolean>}
 */
async function isPasswordBreached(password) {
  try {
    const sha1 = crypto.createHash('sha1').update(password, 'utf8').digest('hex').toUpperCase();
    const prefix = sha1.slice(0, 5);
    const suffix = sha1.slice(5);

    const res = await fetch(`https://api.pwnedpasswords.com/range/${prefix}`, {
      headers: { 'Add-Padding': 'true' },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return false;

    const text = await res.text();
    for (const line of text.split('\n')) {
      const [hashSuffix, count] = line.split(':');
      if (hashSuffix && hashSuffix.trim() === suffix && Number(count) > 0) {
        return true;
      }
    }
    return false;
  } catch (err) {
    console.error('[passwordPolicy] HIBP check failed (non-fatal):', err.message);
    return false;
  }
}

/**
 * The single call site for the controllers: throws an Error with
 * `.code = 'weak_password'` and a user-facing `.message` when the password
 * is unacceptable, otherwise resolves.
 * @param {string} password
 * @param {{ email?: string, name?: string }} [context]
 */
async function assertPasswordAcceptable(password, context = {}) {
  const strengthError = validatePasswordStrength(password, context);
  if (strengthError) {
    const err = new Error(strengthError);
    err.code = 'weak_password';
    throw err;
  }

  if (await isPasswordBreached(password)) {
    const err = new Error(
      'This password has appeared in a known data breach. Please choose a different one.'
    );
    err.code = 'weak_password';
    throw err;
  }
}

module.exports = {
  MIN_LENGTH,
  MAX_LENGTH,
  validatePasswordStrength,
  isPasswordBreached,
  assertPasswordAcceptable,
};
