/**
 * Dietician Profile Controller
 * Handles dietician's own profile operations
 */

const fs = require('fs/promises');
const { User } = require('../../models');
const cloudinary = require('../../config/cloudinary');

/**
 * @desc    Get dietician profile
 * @route   GET /api/dietician/profile
 * @access  Private (Dietician)
 */
exports.getDoctorProfile = async (req, res, next) => {
  try {
    const user = await User.findById(req.user._id).select(
      'profile.fullName profile.dateOfBirth profile.profileImage profile.gender dieticianProfile'
    );

    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    res.status(200).json({
      success: true,
      data: {
        fullName: user.profile?.fullName || '',
        dateOfBirth: user.profile?.dateOfBirth || null,
        profileImage: user.profile?.profileImage || '',
        gender: user.profile?.gender || '',
        specialization: user.dieticianProfile?.specialization || '',
        experience: user.dieticianProfile?.experience || 0,
        qualification: user.dieticianProfile?.qualification || '',
        bio: user.dieticianProfile?.bio || '',
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Update dietician profile
 * @route   PUT /api/dietician/profile
 * @access  Private (Dietician)
 */
exports.updateDoctorProfile = async (req, res, next) => {
  try {
    const { fullName, dateOfBirth, gender, specialization, experience, qualification, bio } =
      req.body;

    const updateData = {};

    // Profile fields
    if (fullName !== undefined) updateData['profile.fullName'] = fullName;
    if (dateOfBirth !== undefined) updateData['profile.dateOfBirth'] = new Date(dateOfBirth);
    if (gender !== undefined) updateData['profile.gender'] = gender;

    // Dietician-specific fields
    if (specialization !== undefined)
      updateData['dieticianProfile.specialization'] = specialization;
    if (experience !== undefined) updateData['dieticianProfile.experience'] = Number(experience);
    if (qualification !== undefined) updateData['dieticianProfile.qualification'] = qualification;
    if (bio !== undefined) updateData['dieticianProfile.bio'] = bio;

    const user = await User.findByIdAndUpdate(req.user._id, updateData, {
      new: true,
      runValidators: true,
    }).select(
      'profile.fullName profile.dateOfBirth profile.profileImage profile.gender dieticianProfile'
    );

    res.status(200).json({
      success: true,
      message: 'Profile updated successfully',
      data: {
        fullName: user.profile?.fullName || '',
        dateOfBirth: user.profile?.dateOfBirth || null,
        profileImage: user.profile?.profileImage || '',
        gender: user.profile?.gender || '',
        specialization: user.dieticianProfile?.specialization || '',
        experience: user.dieticianProfile?.experience || 0,
        qualification: user.dieticianProfile?.qualification || '',
        bio: user.dieticianProfile?.bio || '',
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Upload dietician profile image
 * @route   POST /api/dietician/profile/image
 * @access  Private (Dietician)
 */
exports.uploadDoctorProfileImage = async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'Please upload an image file',
      });
    }

    const uploadResult = await cloudinary.uploader.upload(req.file.path, {
      folder: 'docwellness/profiles',
    });
    await fs.unlink(req.file.path).catch(() => {});
    const imageUrl = uploadResult.secure_url;

    await User.findByIdAndUpdate(req.user._id, {
      'profile.profileImage': imageUrl,
    });

    res.status(200).json({
      success: true,
      message: 'Profile image uploaded successfully',
      data: { imageUrl },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Get assigned doctor profile (for patient)
 * @route   GET /api/patient/assigned-doctor/profile
 * @access  Private (Patient)
 */
exports.getAssignedDoctorProfile = async (req, res, next) => {
  try {
    const config = require('../../config/environment');
    const dieticianId = config.defaultDieticianId;

    if (!dieticianId) {
      return res.status(404).json({
        success: false,
        message: 'No assigned doctor found',
      });
    }

    const doctor = await User.findById(dieticianId).select(
      'profile.fullName profile.dateOfBirth profile.profileImage profile.gender dieticianProfile'
    );

    if (!doctor) {
      return res.status(404).json({
        success: false,
        message: 'Doctor not found',
      });
    }

    res.status(200).json({
      success: true,
      data: {
        fullName: doctor.profile?.fullName || '',
        dateOfBirth: doctor.profile?.dateOfBirth || null,
        profileImage: doctor.profile?.profileImage || '',
        gender: doctor.profile?.gender || '',
        specialization: doctor.dieticianProfile?.specialization || '',
        experience: doctor.dieticianProfile?.experience || 0,
        qualification: doctor.dieticianProfile?.qualification || '',
        bio: doctor.dieticianProfile?.bio || '',
      },
    });
  } catch (error) {
    next(error);
  }
};
