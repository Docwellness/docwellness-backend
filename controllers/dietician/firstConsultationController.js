const fs = require('fs/promises');
const { FirstConsultation, User } = require('../../models');
const cloudinary = require('../../config/cloudinary');

/**
 * @desc    Get the latest first consultation for a patient
 * @route   GET /api/dietician/patients/:patientId/first-consultation
 * @access  Private (Dietician)
 */
exports.getFirstConsultation = async (req, res, next) => {
  try {
    const { patientId } = req.params;

    const consultation = await FirstConsultation.findOne({ patient: patientId }).sort({
      createdAt: -1,
    });

    res.status(200).json({
      success: true,
      data: consultation || null,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Create or update a first consultation form
 * @route   PUT /api/dietician/patients/:patientId/first-consultation
 * @access  Private (Dietician)
 */
exports.upsertFirstConsultation = async (req, res, next) => {
  try {
    const { patientId } = req.params;
    const dieticianId = req.user._id;
    let payload = req.body || {};
    console.log('REQ BODY ===>', JSON.stringify(req.body));

    if (req.body && typeof req.body.data === 'string') {
      try {
        payload = JSON.parse(req.body.data);
      } catch (err) {
        console.error('Failed to parse req.body.data JSON', err);
        return res.status(400).json({
          success: false,
          message: 'Invalid JSON in "data" field',
        });
      }
    }

    console.log('FINAL PAYLOAD =>', JSON.stringify(payload, null, 2));

    const existingConsultation = await FirstConsultation.findOne({
      patient: patientId,
      dietician: dieticianId,
    });

    let consultation;
    let fileUrl = null;
    if (req.file?.path) {
      const uploadResult = await cloudinary.uploader.upload(req.file.path, {
        folder: 'docwellness/labs',
      });
      await fs.unlink(req.file.path).catch(() => {});
      fileUrl = uploadResult.secure_url;
    }

    if (existingConsultation) {
      existingConsultation.set(payload);
      if (fileUrl) {
        existingConsultation.labReports = existingConsultation.labReports || {};
        if (!Array.isArray(existingConsultation.labReports.files)) {
          existingConsultation.labReports.files = [];
        }
        existingConsultation.labReports.files.push(fileUrl);
      }
      consultation = await existingConsultation.save();
    } else {
      const baseData = {
        patient: patientId,
        dietician: dieticianId,
        ...payload,
      };

      if (fileUrl) {
        baseData.labReports = baseData.labReports || {};
        baseData.labReports.files = Array.isArray(baseData.labReports.files)
          ? baseData.labReports.files
          : [];
        baseData.labReports.files.push(fileUrl);
      }

      consultation = await FirstConsultation.create(baseData);
    }

    console.log('SAVED DOC ===>', consultation.toObject());

    // Update patient's status with firstConsultationId
    await User.findByIdAndUpdate(patientId, {
      $set: {
        'status.firstConsultationId': consultation._id.toString(),
      },
    });
    console.log('Updated patient status with firstConsultationId:', consultation._id.toString());

    res.status(200).json({
      success: true,
      message: 'First consultation saved',
      data: consultation,
    });
  } catch (error) {
    next(error);
  }
};
