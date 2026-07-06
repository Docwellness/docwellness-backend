/**
 * Patient Authentication Controller
 * Handles patient-specific authentication operations
 *
 * Flow: Single-step registration (profile + health data) → Login
 */

const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { User } = require('../../models');
const config = require('../../config/environment');
// const { sendEmail, sendWelcomeEmail } = require('../../utils/emailService');
const { normalizeHealthProfileNumbers } = require('../../utils/healthProfileUtils');

/**
 * Generate JWT Token for patient
 * @param {string} id - User ID
 * @returns {string} JWT token
 */
const generateToken = (id) => {
  return jwt.sign({ id }, config.jwtSecret, {
    expiresIn: config.jwtExpire,
  });
};

/**
 * @desc    Unified Registration (Sign Up Screen)
 * @route   POST /api/patient/auth/register
 * @access  Public
 * @body    { username, email, password, profile, healthProfile }
 */
exports.register = async (req, res, next) => {
  try {
    const { username, email, password, profile, healthProfile } = req.body || {};

    const normalizedHealthProfile = healthProfile && typeof healthProfile === 'object'
      ? { ...healthProfile }
      : {};
    normalizeHealthProfileNumbers(normalizedHealthProfile);
    const safeProfile = profile && typeof profile === 'object' ? profile : {};

    console.log('📝 Patient Registration attempt:', { username, email });

    // Check if user already exists with email
    const existingEmail = await User.findOne({ email });
    if (existingEmail) {
      console.log('Registration failed: Email already exists');
      return res.status(400).json({
        success: false,
        message: 'User already exists with this email',
      });
    }

    // Check if username is taken
    const existingUsername = await User.findOne({ username });
    if (existingUsername) {
      console.log('Registration failed: Username already exists');
      return res.status(400).json({
        success: false,
        message: 'Username is already taken',
      });
    }

    // Create patient user with full profile information
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
      username,
      email,
      password,
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

    // Generate token
    const token = generateToken(user._id);

    console.log('Patient registered successfully (full profile):', user._id);

    // Send welcome email (non-blocking)
    // sendWelcomeEmail(user).catch(console.error);

    res.status(201).json({
      success: true,
      message: 'Registration successful! Welcome to DocWellness.',
      data: {
        _id: user._id,
        username: user.username,
        email: user.email,
        role: user.role,
        token,
      },
    });
  } catch (error) {
    console.log('Registration error:', error.message);
    next(error);
  }
};

/**
 * @desc    Login patient
 * @route   POST /api/patient/auth/login
 * @access  Public
 * @body    { email, password } OR { username, password }
 */
exports.login = async (req, res, next) => {
  try {
    const { email, username, password } = req.body;

    console.log('Login attempt:', { email: email || username });

    // Find user by email or username
    const query = email ? { email } : { username };
    const user = await User.findOne(query).select('+password');

    if (!user) {
      console.log('Login failed: User not found');
      return res.status(401).json({
        success: false,
        message: 'Invalid credentials',
      });
    }

    // Check if user is a patient
    // if (user.role !== 'patient') {
    //   console.log('Login failed: Not a patient account');
    //   return res.status(403).json({
    //     success: false,
    //     message: 'Please use the dietician login portal',
    //   });
    // }

    // Check password
    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      console.log('Login failed: Invalid password');
      return res.status(401).json({
        success: false,
        message: 'Invalid credentials',
      });
    }

    // Update last login
    user.lastLogin = new Date();
    await user.save({ validateBeforeSave: false });

    // Generate token
    const token = generateToken(user._id);

    // Check if profile is complete
    const isProfileComplete =
      user.isVerified &&
      user.profile &&
      user.profile.fullName &&
      user.healthProfile &&
      user.healthProfile.weight > 0;

    console.log('Login successful:', user._id);

    // res.status(200).json({
    //   success: true,
    //   message: 'Login successful',
    //   data: {
    //     user: {
    //       _id: user._id,
    //       username: user.username,
    //       email: user.email,
    //       role: user.role,
    //     },
    //     token,
    //   },
    // });
    res.status(200).json({
      success: true,
      message: 'Login successful',
      _id: user._id,
      role: user.role,
      token,
    });
  } catch (error) {
    console.log('Login error:', error.message);
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
 * @desc    Logout patient
 * @route   POST /api/patient/auth/logout
 * @access  Private (Patient)
 */
exports.logout = async (req, res, next) => {
  try {
    console.log('Patient logged out:', req.user._id);

    // In stateless JWT, logout is handled client-side
    res.status(200).json({
      success: true,
      message: 'Logged out successfully',
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Forgot password - send reset email
 * @route   POST /api/patient/auth/forgot-password
 * @access  Public
 * @body    { email }
 */
exports.forgotPassword = async (req, res, next) => {
  try {
    const { email } = req.body;

    console.log('🔑 Forgot password request for:', email);

    const user = await User.findOne({ email, role: 'patient' });

    if (!user) {
      console.log('Forgot password: No patient found');
      return res.status(404).json({
        success: false,
        message: 'No patient found with this email',
      });
    }

    // Generate reset token
    const resetToken = crypto.randomBytes(32).toString('hex');
    user.resetPasswordToken = crypto
      .createHash('sha256')
      .update(resetToken)
      .digest('hex');
    user.resetPasswordExpire = Date.now() + 10 * 60 * 1000; // 10 minutes

    await user.save();

    // Create reset URL
    const resetUrl = `${config.frontendUrl}/patient/reset-password/${resetToken}`;

    try {
      await sendEmail({
        to: user.email,
        subject: 'Password Reset - DocWellness',
        text: `You requested a password reset. Please visit: ${resetUrl}`,
        html: `
          <h1>Password Reset Request</h1>
          <p>You requested a password reset for your DocWellness patient account.</p>
          <p>Click the link below to reset your password:</p>
          <a href="${resetUrl}" style="display: inline-block; padding: 10px 20px; background-color: #4CAF50; color: white; text-decoration: none; border-radius: 5px;">Reset Password</a>
          <p>This link will expire in 10 minutes.</p>
          <p>If you didn't request this, please ignore this email.</p>
        `,
      });

      console.log('Password reset email sent to:', email);

      res.status(200).json({
        success: true,
        message: 'Password reset email sent',
      });
    } catch (emailError) {
      console.log('Email send failed:', emailError.message);
      user.resetPasswordToken = undefined;
      user.resetPasswordExpire = undefined;
      await user.save();

      return res.status(500).json({
        success: false,
        message: 'Email could not be sent',
      });
    }
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Reset password with token
 * @route   POST /api/patient/auth/reset-password/:token
 * @access  Public
 * @body    { password }
 */
exports.resetPassword = async (req, res, next) => {
  try {
    const { password } = req.body;
    const resetPasswordToken = crypto
      .createHash('sha256')
      .update(req.params.token)
      .digest('hex');

    console.log('🔄 Password reset attempt');

    const user = await User.findOne({
      resetPasswordToken,
      resetPasswordExpire: { $gt: Date.now() },
      role: 'patient',
    });

    if (!user) {
      console.log('Password reset: Invalid or expired token');
      return res.status(400).json({
        success: false,
        message: 'Invalid or expired reset token',
      });
    }

    // Set new password
    user.password = password;
    user.resetPasswordToken = undefined;
    user.resetPasswordExpire = undefined;
    await user.save();

    // Generate new token
    const token = generateToken(user._id);

    console.log('Password reset successful for:', user._id);

    res.status(200).json({
      success: true,
      message: 'Password reset successful',
      data: { token },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Change password (when logged in)
 * @route   PUT /api/patient/auth/change-password
 * @access  Private (Patient)
 * @body    { currentPassword, newPassword }
 */
exports.changePassword = async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body;

    console.log('🔒 Password change attempt for:', req.user._id);

    // Get user with password
    const user = await User.findById(req.user._id).select('+password');

    // Check current password
    const isMatch = await user.comparePassword(currentPassword);
    if (!isMatch) {
      console.log('Password change: Current password incorrect');
      return res.status(401).json({
        success: false,
        message: 'Current password is incorrect',
      });
    }

    // Update password
    user.password = newPassword;
    await user.save();

    // Generate new token
    const token = generateToken(user._id);

    console.log('Password changed successfully for:', user._id);

    res.status(200).json({
      success: true,
      message: 'Password changed successfully',
      data: { token },
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
