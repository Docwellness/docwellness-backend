/**
 * Patient Profile Controller
 * Handles patient profile and health profile operations
 */

const fs = require('fs/promises');
const { User } = require('../../models');
const { calculateBMI, calculateCalorieNeeds } = require('../../utils/helpers');
const cloudinary = require('../../config/cloudinary');
const { cloudinaryUserFolder } = require('../../utils/cloudinaryFolder');
const { normalizeHealthProfileNumbers } = require('../../utils/healthProfileUtils');
const { verifyPassword } = require('../../utils/supabaseAuth');
const { parseDateFromDDMMYYYY } = require('../../utils/dateUtils');
const {
  PATIENT_DATA_CATEGORIES,
  CATEGORY_KEYS,
  ACCOUNT_ONLY_KEYS,
  deletePatientData,
  erasePatientCompletely,
} = require('../../utils/patientDataDeletion');
const { logAuditEvent } = require('../../utils/auditLog');

/**
 * @desc    Get patient profile
 * @route   GET /api/patient/profile
 * @access  Private (Patient)
 */
exports.getProfile = async (req, res, next) => {
  try {
    const user = await User.findById(req.user._id).select('-password');

    res.status(200).json({
      success: true,
      data: user,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Update patient profile
 * @route   PUT /api/patient/profile
 * @access  Private (Patient)
 */
exports.updateProfile = async (req, res, next) => {
  try {
    const { profile, email } = req.body;

    // Fields that can be updated
    const allowedProfileFields = ['fullName', 'whatsappNumber', 'dateOfBirth', 'gender'];

    // Build update object
    const updateData = {};
    if (profile) {
      updateData.profile = { ...req.user.profile };
      allowedProfileFields.forEach((field) => {
        if (profile[field] !== undefined) {
          updateData.profile[field] = profile[field];
        }
      });

      if (profile.dateOfBirth !== undefined) {
        const parsedDob = parseDateFromDDMMYYYY(profile.dateOfBirth);
        updateData.profile.dateOfBirth = parsedDob;
      }
    }

    if (email !== undefined) {
      updateData.email = email;
    }

    const user = await User.findByIdAndUpdate(req.user._id, updateData, {
      new: true,
      runValidators: true,
    }).select('-password');

    res.status(200).json({
      success: true,
      message: 'Profile updated successfully',
      data: user,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Upload profile image
 * @route   POST /api/patient/profile/image
 * @access  Private (Patient)
 */
exports.uploadProfileImage = async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'Please upload an image file',
      });
    }

    const uploadResult = await cloudinary.uploader.upload(req.file.path, {
      folder: cloudinaryUserFolder(req.user._id, 'profiles'),
    });
    await fs.unlink(req.file.path).catch(() => {});
    const imageUrl = uploadResult.secure_url;

    const user = await User.findByIdAndUpdate(
      req.user._id,
      { 'profile.profileImage': imageUrl },
      { new: true }
    ).select('-password');

    res.status(200).json({
      success: true,
      message: 'Profile image uploaded successfully',
      data: {
        imageUrl,
        user,
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Get health profile
 * @route   GET /api/patient/health-profile
 * @access  Private (Patient)
 */
exports.getHealthProfile = async (req, res, next) => {
  try {
    const user = await User.findById(req.user._id).select(
      'healthProfile profile.gender profile.dateOfBirth'
    );

    // Calculate additional health metrics
    let additionalMetrics = {};
    if (user.healthProfile) {
      const { weight, height } = user.healthProfile;

      // Calculate BMI
      if (weight && height) {
        additionalMetrics.bmi = calculateBMI(weight, height);
        additionalMetrics.bmiCategory = getBMICategory(additionalMetrics.bmi);
      }

      // Calculate daily calorie needs
      if (weight && height && user.profile?.dateOfBirth && user.profile?.gender) {
        const age = calculateAge(user.profile.dateOfBirth);
        additionalMetrics.dailyCalorieNeeds = calculateCalorieNeeds(
          weight,
          height,
          age,
          user.profile.gender,
          user.healthProfile.activityLevel
        );
      }
    }

    res.status(200).json({
      success: true,
      data: {
        healthProfile: user.healthProfile,
        metrics: additionalMetrics,
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Update health profile
 * @route   PUT /api/patient/health-profile
 * @access  Private (Patient)
 */
exports.updateHealthProfile = async (req, res, next) => {
  try {
    const payload = req.body || {};
    let incomingHealthProfile = null;
    if (payload.healthProfile && typeof payload.healthProfile === 'object') {
      incomingHealthProfile = { ...payload.healthProfile };
      normalizeHealthProfileNumbers(incomingHealthProfile);
    } else {
      incomingHealthProfile = {
        weight: payload.weight,
        height: payload.height,
        bmi: payload.bmi,
        weightIndex: payload.weightIndex,
      };
      normalizeHealthProfileNumbers(incomingHealthProfile);
    }

    const healthProfile = { ...req.user.healthProfile };
    const assignIfDefined = (field, value) => {
      if (value !== undefined) {
        healthProfile[field] = value;
      }
    };

    assignIfDefined('weight', incomingHealthProfile.weight);
    assignIfDefined('height', incomingHealthProfile.height);
    assignIfDefined('bmi', incomingHealthProfile.bmi);
    assignIfDefined('weightIndex', incomingHealthProfile.weightIndex);

    const stringSource =
      payload.healthProfile && typeof payload.healthProfile === 'object'
        ? payload.healthProfile
        : payload;

    assignIfDefined('primaryGoal', stringSource.primaryGoal ?? stringSource.goal);
    assignIfDefined('targetWeight', stringSource.targetWeight);
    assignIfDefined('activityLevel', stringSource.activityLevel);
    if (stringSource.healthConcerns !== undefined) {
      healthProfile.healthConcerns = stringSource.healthConcerns;
    }
    if (payload.medicalConditions !== undefined) {
      healthProfile.medicalConditions = payload.medicalConditions;
    }

    const user = await User.findByIdAndUpdate(
      req.user._id,
      { healthProfile },
      { new: true, runValidators: true }
    ).select('healthProfile');

    // Calculate metrics
    let metrics = {};
    if (healthProfile.weight && healthProfile.height) {
      metrics.bmi = calculateBMI(healthProfile.weight, healthProfile.height);
      metrics.bmiCategory = getBMICategory(metrics.bmi);
    }

    res.status(200).json({
      success: true,
      message: 'Health profile updated successfully',
      data: {
        healthProfile: user.healthProfile,
        metrics,
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Delete patient account
 * @route   DELETE /api/patient/profile
 * @access  Private (Patient)
 */
exports.deleteAccount = async (req, res, next) => {
  try {
    const { password } = req.body;

    // Verify password before deletion (against Supabase, which owns credentials)
    const isMatch = await verifyPassword(req.user.email, password);

    if (!isMatch) {
      return res.status(401).json({
        success: false,
        message: 'Password is incorrect',
      });
    }

    // Full erase: every data category, the User document and the Supabase
    // identity (not just the User record, which would orphan meal logs,
    // chats, photos, lab reports, ...).
    const deleted = await erasePatientCompletely(req.user);
    logAuditEvent('patient_deleted', { patientId: String(req.user._id), via: 'self_service', deleted });

    res.status(200).json({
      success: true,
      message: 'Account deleted successfully',
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    List the data categories a patient can choose to delete
 * @route   GET /api/patient/data-deletion/categories
 * @access  Private (Patient)
 */
exports.getDeletableDataCategories = (req, res) => {
  res.status(200).json({
    success: true,
    data: {
      categories: PATIENT_DATA_CATEGORIES.filter((c) => !c.accountOnly).map(({ key, label }) => ({
        key,
        label,
      })),
    },
  });
};

/**
 * @desc    Delete selected categories of the patient's own data, or the whole
 *          account. Password re-entry is required; deletion is immediate.
 * @route   POST /api/patient/data-deletion
 * @body    { password, deleteAccount?: boolean, categories?: string[] }
 * @access  Private (Patient)
 */
exports.requestDataDeletion = async (req, res, next) => {
  try {
    const { password, deleteAccount, categories } = req.body || {};

    const wantsAccountDelete = deleteAccount === true;
    const selected = Array.isArray(categories) ? [...new Set(categories)] : [];

    const invalid = selected.filter((k) => !CATEGORY_KEYS.includes(k) || ACCOUNT_ONLY_KEYS.includes(k));
    if (invalid.length) {
      return res.status(400).json({
        success: false,
        message: `Unknown data category: ${invalid.join(', ')}`,
      });
    }
    if (!wantsAccountDelete && selected.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Select at least one data category to delete.',
      });
    }

    if (!password || !(await verifyPassword(req.user.email, password))) {
      return res.status(401).json({ success: false, message: 'Password is incorrect' });
    }

    if (wantsAccountDelete) {
      const deleted = await erasePatientCompletely(req.user);
      logAuditEvent('patient_deleted', { patientId: String(req.user._id), via: 'self_service', deleted });
      return res.status(200).json({
        success: true,
        message: 'Account deleted successfully',
        data: { accountDeleted: true, deleted },
      });
    }

    const deleted = await deletePatientData([req.user._id], selected, { execute: true });
    logAuditEvent('patient_data_deleted', {
      patientId: String(req.user._id),
      via: 'self_service',
      categories: selected,
      deleted,
    });
    return res.status(200).json({
      success: true,
      message: 'Selected data has been deleted.',
      data: { accountDeleted: false, deleted },
    });
  } catch (error) {
    next(error);
  }
};

// Helper functions

/**
 * Calculate age from date of birth
 * @param {Date} dateOfBirth
 * @returns {number} Age in years
 */
function calculateAge(dateOfBirth) {
  const today = new Date();
  const birthDate = new Date(dateOfBirth);
  let age = today.getFullYear() - birthDate.getFullYear();
  const monthDiff = today.getMonth() - birthDate.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birthDate.getDate())) {
    age--;
  }
  return age;
}

/**
 * Get BMI category based on BMI value
 * @param {number} bmi
 * @returns {string} BMI category
 */
function getBMICategory(bmi) {
  if (bmi < 18.5) return 'Underweight';
  if (bmi < 25) return 'Normal';
  if (bmi < 30) return 'Overweight';
  return 'Obese';
}
