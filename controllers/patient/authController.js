/**
 * Patient Authentication Controller
 *
 * Sign in, sign out, and password reset happen entirely client-side via
 * Supabase. Sign-up needs two backend touchpoints because this project
 * requires email confirmation (so a plain client-side signUp() returns no
 * session): signupRequest creates the Supabase identity and emails a code
 * via Resend, then - once the app verifies that code directly against
 * Supabase and gets a session - register links the resulting identity to a
 * new Mongo profile.
 */

const { User } = require('../../models');
const { sendWelcomeEmail, sendPasswordResetOtp, sendSignupOtp } = require('../../utils/emailService');
const { normalizeHealthProfileNumbers } = require('../../utils/healthProfileUtils');
const { generateRecoveryOtp, generateSignupOtp } = require('../../utils/supabaseAuth');

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

    let dateOfBirth = null;
    if (safeProfile?.dateOfBirth) {
      const [day, month, year] = safeProfile.dateOfBirth.split('-');
      if (day && month && year) {
        const parsed = new Date(`${year}-${month}-${day}`);
        if (!isNaN(parsed)) {
          dateOfBirth = parsed;
        }
      }
    }

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

    res.status(200).json(genericResponse);
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
 * @desc    Logout patient. Kept as a best-effort no-op for backward
 *          compatibility with clients that still call it - actual sign-out
 *          happens client-side via supabase.auth.signOut(), which is what
 *          actually invalidates the session.
 * @route   POST /api/patient/auth/logout
 * @access  Private (Patient)
 */
exports.logout = async (req, res, next) => {
  try {
    console.log('Patient logged out:', req.user._id);
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
