/**
 * Patient Authentication Controller
 *
 * Auth itself (sign up, sign in, sign out, password reset) happens
 * client-side via Supabase - the Flutter apps talk to Supabase directly and
 * get a Supabase session/access token. This controller's job is narrower:
 * link a Supabase identity to its Mongo profile (completeRegistration), and
 * serve/manage that profile data for already-linked accounts.
 */

const { User } = require('../../models');
const { sendWelcomeEmail, sendPasswordResetOtp } = require('../../utils/emailService');
const { normalizeHealthProfileNumbers } = require('../../utils/healthProfileUtils');
const { generateRecoveryOtp } = require('../../utils/supabaseAuth');

/**
 * @desc    Complete registration - links the caller's verified Supabase
 *          identity (req.supabaseUser, set by the supabaseTokenOnly
 *          middleware) to a new Mongo profile. Call this immediately after
 *          `supabase.auth.signUp()` succeeds client-side.
 * @route   POST /api/patient/auth/register
 * @access  Private (valid Supabase token required, no linked profile yet)
 * @body    { username, profile, healthProfile }
 */
exports.register = async (req, res, next) => {
  try {
    const { username, profile, healthProfile } = req.body || {};
    const { id: supabaseUserId, email } = req.supabaseUser;

    console.log('📝 Completing registration for:', email);

    const alreadyLinked = await User.findOne({ supabaseUserId });
    if (alreadyLinked) {
      return res.status(400).json({
        success: false,
        message: 'Registration already completed for this account',
      });
    }

    const existingUsername = await User.findOne({ username });
    if (existingUsername) {
      return res.status(400).json({
        success: false,
        message: 'Username is already taken',
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
      username,
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
        username: user.username,
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
        username: user.username,
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
 * @desc    Check if username is available
 * @route   GET /api/patient/auth/check-username/:username
 * @access  Public
 */
exports.checkUsername = async (req, res, next) => {
  try {
    const { username } = req.params;

    const existingUser = await User.findOne({ username });

    res.status(200).json({
      success: true,
      data: {
        username,
        isAvailable: !existingUser,
      },
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

/**
 * @desc    Resolve a username to its email, so the app can sign in via
 *          Supabase (email-only) even when the user typed a username.
 *          Same information-disclosure profile as check-username (both
 *          confirm a username exists) - just also returns the email, since
 *          that's genuinely needed for username-based sign-in to work at
 *          all under Supabase.
 * @route   GET /api/patient/auth/resolve-username/:username
 * @access  Public
 */
exports.resolveUsername = async (req, res, next) => {
  try {
    const { username } = req.params;

    const user = await User.findOne({ username });
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'No account found with this username',
      });
    }

    res.status(200).json({
      success: true,
      data: { email: user.email },
    });
  } catch (error) {
    next(error);
  }
};
