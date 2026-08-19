/**
 * Patient Authentication Controller
 *
 * The app never talks to Supabase directly - every auth operation (login,
 * signup OTP verification, password reset/change, session refresh, logout)
 * goes through this controller, which holds the only Supabase credentials
 * (the service-role key, via utils/supabaseAuth.js's admin client). This
 * keeps the Flutter build free of any Supabase URL/key, the same way it
 * never embeds Mongo/Cloudinary/OpenAI credentials either.
 *
 * Sign-up needs two backend touchpoints because this project requires email
 * confirmation (so a plain signUp() returns no session): signupRequest
 * creates the Supabase identity and emails a code via Resend, then - once
 * verifySignupOtpEndpoint confirms that code and returns a session -
 * register links the resulting identity to a new Mongo profile.
 */

const { User } = require('../../models');
const { sendWelcomeEmail, sendPasswordResetOtp, sendSignupOtp } = require('../../utils/emailService');
const { normalizeHealthProfileNumbers } = require('../../utils/healthProfileUtils');
const {
  generateRecoveryOtp,
  generateSignupOtp,
  signInWithPassword,
  verifySignupOtp,
  resetPasswordWithOtp,
  refreshSession,
  signOutSession,
  verifyPassword,
  getSupabaseAdmin,
} = require('../../utils/supabaseAuth');
const { parseDateFromDDMMYYYY } = require('../../utils/dateUtils');
const { isLoginLocked, registerFailedLogin, clearFailedLoginAttempts } = require('../../utils/loginLockout');
const { dedupedRefresh } = require('../../utils/refreshDedup');
const { logAuditEvent } = require('../../utils/auditLog');

const sessionResponse = (session) => ({
  accessToken: session.access_token,
  refreshToken: session.refresh_token,
  expiresAt: session.expires_at,
});

const bearerTokenFrom = (req) => {
  const header = req.headers.authorization || '';
  return header.startsWith('Bearer') ? header.split(' ')[1] : null;
};

/**
 * @desc    Start registration: creates the Supabase identity (unconfirmed)
 *          and emails a verification code via Resend. This project has
 *          email confirmation required, so a plain client-side
 *          supabase.auth.signUp() wouldn't return a session immediately -
 *          the app instead calls this, then supabase.auth.verifyOtp(type:
 *          signup) directly to confirm and get a session, then register
 *          (below) to link the profile.
 * @route   POST /api/patient/auth/signup-request
 * @access  Public
 * @body    { email, password }
 */
exports.signupRequest = async (req, res, next) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: 'Email and password are required',
      });
    }

    const existingEmail = await User.findOne({ email: email.toLowerCase() });
    if (existingEmail) {
      return res.status(400).json({ success: false, message: 'User already exists with this email' });
    }

    let otp;
    try {
      otp = await generateSignupOtp(email, password);
    } catch (err) {
      if (err.code === 'email_taken') {
        return res.status(400).json({ success: false, message: 'User already exists with this email' });
      }
      throw err;
    }

    await sendSignupOtp(email, otp);
    console.log('Signup verification code sent to:', email);

    res.status(200).json({
      success: true,
      message: 'Verification code sent to your email',
    });
  } catch (error) {
    console.log('Signup request error:', error.message);
    next(error);
  }
};

/**
 * @desc    Step 2 of signup: verifies the emailed code (see signupRequest
 *          above) and returns a Supabase session. The app then calls
 *          /auth/register (below) with the returned accessToken to link a
 *          Mongo profile - this is the server-side replacement for what
 *          used to be a direct client call to
 *          supabase.auth.verifyOtp(type: 'signup').
 * @route   POST /api/patient/auth/verify-signup-otp
 * @access  Public
 * @body    { email, code }
 */
exports.verifySignupOtpEndpoint = async (req, res, next) => {
  try {
    const { email, code } = req.body || {};
    if (!email || !code) {
      return res.status(400).json({ success: false, message: 'Email and code are required' });
    }

    let session;
    try {
      session = await verifySignupOtp(email, code);
    } catch (err) {
      return res.status(400).json({ success: false, message: 'Invalid or expired code. Please try again.' });
    }

    res.status(200).json({ success: true, data: sessionResponse(session) });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Log in with email/password - server-side replacement for the
 *          client calling supabase.auth.signInWithPassword() directly.
 *          Mounted at both /api/patient/auth/login and
 *          /api/dietician/auth/login (routes/patient.js, routes/dietician.js)
 *          - `req.loginRole` (set by middlewares/deviceRisk.js's loginRole()
 *          on each mount) picks the lockout threshold (P9-B2: 5/15min
 *          patient, 3/10min dietician) and drives the audit-log role field.
 * @route   POST /api/patient/auth/login
 * @route   POST /api/dietician/auth/login
 * @access  Public
 * @body    { email, password }
 */
exports.login = async (req, res, next) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Email and password are required' });
    }

    const role = req.loginRole || 'patient';
    const normalizedEmail = email.trim().toLowerCase();

    const lockStatus = await isLoginLocked(role, normalizedEmail);
    if (lockStatus.locked) {
      logAuditEvent('login_locked', { role, email: normalizedEmail });
      res.set('Retry-After', String(lockStatus.retryAfter));
      return res.status(429).json({
        success: false,
        message: 'Too many failed login attempts. Please try again later.',
        retryAfter: lockStatus.retryAfter,
      });
    }

    let session;
    try {
      session = await signInWithPassword(email.trim(), password);
    } catch (err) {
      logAuditEvent('login_failed', { role, email: normalizedEmail });

      const failure = await registerFailedLogin(role, normalizedEmail);
      if (failure.locked) {
        logAuditEvent('login_locked', { role, email: normalizedEmail });
        res.set('Retry-After', String(failure.retryAfter));
        return res.status(429).json({
          success: false,
          message: 'Too many failed login attempts. Please try again later.',
          retryAfter: failure.retryAfter,
        });
      }

      // Generic message regardless of whether the email or password was
      // wrong - same reasoning as forgotPassword's generic response below.
      return res.status(401).json({ success: false, message: 'Invalid email or password' });
    }

    await clearFailedLoginAttempts(role, normalizedEmail);
    logAuditEvent('login_success', { role, email: normalizedEmail });

    res.status(200).json({ success: true, data: sessionResponse(session) });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Complete registration - links the caller's verified Supabase
 *          identity (req.supabaseUser, set by the supabaseTokenOnly
 *          middleware) to a new Mongo profile. Call this after
 *          `supabase.auth.verifyOtp(type: signup)` succeeds client-side.
 * @route   POST /api/patient/auth/register
 * @access  Private (valid Supabase token required, no linked profile yet)
 * @body    { profile, healthProfile }
 */
exports.register = async (req, res, next) => {
  try {
    const { profile, healthProfile } = req.body || {};
    const { id: supabaseUserId, email } = req.supabaseUser;

    console.log('📝 Completing registration for:', email);

    const alreadyLinked = await User.findOne({ supabaseUserId });
    if (alreadyLinked) {
      return res.status(400).json({
        success: false,
        message: 'Registration already completed for this account',
      });
    }

    const normalizedHealthProfile = healthProfile && typeof healthProfile === 'object'
      ? { ...healthProfile }
      : {};
    normalizeHealthProfileNumbers(normalizedHealthProfile);
    const safeProfile = profile && typeof profile === 'object' ? profile : {};

    const dateOfBirth = parseDateFromDDMMYYYY(safeProfile?.dateOfBirth);

    const user = await User.create({
      supabaseUserId,
      email,
      role: 'patient',
      profile: {
        fullName: safeProfile.fullName,
        gender: safeProfile.gender,
        dateOfBirth,
        whatsappNumber: safeProfile.whatsappNumber,
      },
      healthProfile: {
        weight: normalizedHealthProfile.weight,
        height: normalizedHealthProfile.height,
        bmi: normalizedHealthProfile.bmi,
        weightIndex: normalizedHealthProfile.weightIndex,
        primaryGoal: normalizedHealthProfile.primaryGoal,
        targetWeight: normalizedHealthProfile.targetWeight,
        activityLevel: normalizedHealthProfile.activityLevel,
        healthConcerns: normalizedHealthProfile.healthConcerns,
      },
      isVerified: true,
    });

    console.log('Patient registration completed:', user._id);

    // Non-blocking - failure here shouldn't fail registration itself
    sendWelcomeEmail(user).catch((err) => console.error('Welcome email failed:', err.message));

    res.status(201).json({
      success: true,
      message: 'Registration successful! Welcome to DocWellness.',
      data: {
        _id: user._id,
        email: user.email,
        role: user.role,
      },
    });
  } catch (error) {
    console.log('Registration error:', error.message);
    next(error);
  }
};

/**
 * @desc    Request a password reset code. Generates an OTP via Supabase's
 *          admin API and emails it via Resend (Supabase's own email
 *          templates/sending are never used). Always responds with the same
 *          generic message regardless of whether the email is registered,
 *          to avoid leaking which emails have accounts.
 * @route   POST /api/patient/auth/forgot-password
 * @access  Public
 * @body    { email }
 */
exports.forgotPassword = async (req, res, next) => {
  const genericResponse = {
    success: true,
    message: 'If an account exists with this email, a reset code has been sent.',
  };

  try {
    const { email } = req.body || {};
    if (!email) {
      return res.status(400).json({ success: false, message: 'Email is required' });
    }

    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) {
      // Don't reveal whether the email is registered
      return res.status(200).json(genericResponse);
    }

    const otp = await generateRecoveryOtp(email);
    if (otp) {
      await sendPasswordResetOtp(user, otp);
      console.log('Password reset code sent to:', email);
    } else {
      console.log('Password reset requested but Supabase had no matching identity:', email);
    }

    logAuditEvent('password_reset_requested', { email: email.toLowerCase() });
    res.status(200).json(genericResponse);
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Completes the password-reset flow: verifies the code emailed by
 *          forgotPassword above and sets the new password directly, in one
 *          call - replaces what used to be three separate client-side
 *          Supabase calls (verifyOtp -> updateUser -> signOut). No session
 *          is returned; the app sends the patient back to the login screen.
 * @route   POST /api/patient/auth/reset-password
 * @access  Public
 * @body    { email, code, newPassword }
 */
exports.resetPassword = async (req, res, next) => {
  try {
    const { email, code, newPassword } = req.body || {};
    if (!email || !code || !newPassword) {
      return res.status(400).json({
        success: false,
        message: 'Email, code, and new password are required',
      });
    }

    try {
      await resetPasswordWithOtp(email, code, newPassword);
    } catch (err) {
      return res.status(400).json({ success: false, message: 'Invalid or expired code. Please try again.' });
    }

    logAuditEvent('password_reset_completed', { email: email.toLowerCase() });
    res.status(200).json({
      success: true,
      message: 'Password reset. Please sign in with your new password.',
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Exchanges a refresh token for a new session - server-side
 *          replacement for the client's own supabase.auth.refreshSession(),
 *          called proactively by the app before an access token expires
 *          (see docwellness-user's ApiService.request()). Concurrent calls
 *          carrying the same refresh token are de-duplicated (P9-B3,
 *          utils/refreshDedup.js) rather than each independently racing
 *          Supabase's own refresh-token rotation.
 * @route   POST /api/patient/auth/refresh
 * @route   POST /api/dietician/auth/refresh
 * @access  Public
 * @body    { refreshToken }
 */
exports.refresh = async (req, res, next) => {
  try {
    const { refreshToken } = req.body || {};
    if (!refreshToken) {
      return res.status(400).json({ success: false, message: 'refreshToken is required' });
    }

    let session;
    let deduped;
    try {
      ({ session, deduped } = await dedupedRefresh(refreshToken, () => refreshSession(refreshToken)));
    } catch (err) {
      return res.status(401).json({ success: false, message: 'Session expired, please log in again' });
    }

    logAuditEvent(deduped ? 'refresh_deduped' : 'refresh_used', { role: req.loginRole || 'patient' });

    res.status(200).json({ success: true, data: sessionResponse(session) });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Get current logged in patient
 * @route   GET /api/patient/auth/me
 * @access  Private (Patient)
 */
exports.getMe = async (req, res, next) => {
  try {
    const user = await User.findById(req.user._id);

    const isProfileComplete =
      user.isVerified &&
      user.profile &&
      user.profile.fullName &&
      user.healthProfile &&
      user.healthProfile.weight > 0;

    console.log('Fetching current user:', user._id);

    res.status(200).json({
      success: true,
      data: {
        _id: user._id,
        email: user.email,
        role: user.role,
        profile: user.profile,
        healthProfile: user.healthProfile,
        isVerified: user.isVerified,
        createdAt: user.createdAt,
        lastLogin: user.lastLogin,
        isProfileComplete,
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Changes the current patient's password: reauthenticates with
 *          their current password (same confirmation step the old
 *          client-side flow required before calling updateUser), sets the
 *          new one via the admin API, then signs out every other session on
 *          the account (scope: 'others') while leaving this one intact -
 *          replaces the old client-side signInWithPassword -> updateUser ->
 *          signOut(scope: others) sequence.
 * @route   POST /api/patient/auth/change-password
 * @access  Private (Patient)
 * @body    { currentPassword, newPassword }
 */
exports.changePassword = async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || !newPassword) {
      return res.status(400).json({
        success: false,
        message: 'Current password and new password are required',
      });
    }

    const isMatch = await verifyPassword(req.user.email, currentPassword);
    if (!isMatch) {
      return res.status(400).json({ success: false, message: 'Current password is incorrect' });
    }

    const { error } = await getSupabaseAdmin().auth.admin.updateUserById(req.user.supabaseUserId, {
      password: newPassword,
    });
    if (error) {
      return next(new Error(error.message || 'Could not update password'));
    }

    const callerToken = bearerTokenFrom(req);
    if (callerToken) {
      await signOutSession(callerToken, 'others');
    }

    res.status(200).json({ success: true, message: 'Password changed successfully' });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Logout patient - revokes the Supabase session behind the
 *          caller's own access token (scope: 'global'), the server-side
 *          replacement for the old client-side supabase.auth.signOut(),
 *          which is what actually invalidated the session before.
 * @route   POST /api/patient/auth/logout
 * @access  Private (Patient)
 */
exports.logout = async (req, res, next) => {
  try {
    const callerToken = bearerTokenFrom(req);
    if (callerToken) {
      await signOutSession(callerToken, 'global');
    }
    console.log('Patient logged out:', req.user._id);
    logAuditEvent('logout', { role: req.user.role, userId: req.user._id.toString() });
    res.status(200).json({
      success: true,
      message: 'Logged out successfully',
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Check if email is available
 * @route   GET /api/patient/auth/check-email/:email
 * @access  Public
 */
exports.checkEmail = async (req, res, next) => {
  try {
    const { email } = req.params;

    const existingUser = await User.findOne({ email: email.toLowerCase() });

    res.status(200).json({
      success: true,
      data: {
        email,
        isAvailable: !existingUser,
      },
    });
  } catch (error) {
    next(error);
  }
};
