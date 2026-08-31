const fs = require('fs/promises');
const { FirstConsultation, User, Notification } = require('../../models');
const cloudinary = require('../../config/cloudinary');
const { cloudinaryUserFolder } = require('../../utils/cloudinaryFolder');
const { getChatIO } = require('../../chat');
const { sendPushToTokens } = require('../../utils/push');

// Only the patient can set these, via the patient-facing submitConsent
// endpoint - a dietician's save must never be able to write them, and any
// edit to the rest of the form invalidates a prior consent (see below).
const CONSENT_FIELD_IDS = ['consent_acknowledgement', 'consent_signature_name'];

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

    // A dietician can never write the Consent & Confidentiality answers -
    // only the patient can, via the patient-facing submitConsent endpoint.
    // Strip them regardless of what the client sent.
    if (Array.isArray(payload.customAnswers)) {
      payload.customAnswers = payload.customAnswers.filter(
        (a) => !CONSENT_FIELD_IDS.includes(a?.fieldId)
      );
    }

    const existingConsultation = await FirstConsultation.findOne({
      patient: patientId,
      dietician: dieticianId,
    });

    // Editing any other question invalidates a prior consent - the patient
    // needs to re-review before the dietician can act on the updated
    // information again. Only relevant when there's something to invalidate.
    const hadConsent =
      !!existingConsultation &&
      (existingConsultation.customAnswers || []).some(
        (a) =>
          a.fieldId === 'consent_acknowledgement' &&
          Array.isArray(a.value) &&
          a.value.includes('I consent')
      );

    let consultation;
    let fileUrl = null;
    if (req.file?.path) {
      const uploadResult = await cloudinary.uploader.upload(req.file.path, {
        folder: cloudinaryUserFolder(patientId, 'labs'),
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
    const statusUpdate = {
      'status.firstConsultationId': consultation._id.toString(),
    };
    if (hadConsent) {
      statusUpdate['status.patientConsented'] = false;
    }
    await User.findByIdAndUpdate(patientId, { $set: statusUpdate });
    console.log('Updated patient status with firstConsultationId:', consultation._id.toString());

    // Whenever a dietician saves the first consultation, the patient has to
    // (re-)review it and submit consent before a diet or exercise plan can
    // be created for them - so nudge them every save, not only on the
    // consent-invalidation case. A dietician can never write the consent
    // answers, so a save never leaves the patient consented; `hadConsent`
    // only picks the wording (first review vs. re-review). In-app
    // Notification + socket push always; real FCM push is best-effort and
    // never blocks or fails the save (same convention as activateDietPlan).
    try {
      const notif = await Notification.create({
        userId: patientId,
        title: hadConsent
          ? 'Your first consultation was updated'
          : 'Review your first consultation',
        message: hadConsent
          ? 'Your dietician updated your first consultation. Please review it again and re-submit your consent.'
          : 'Your dietician has completed your first consultation. Please review it and provide your consent to continue.',
        type: 'consultation',
        referenceId: consultation._id,
        referenceModel: 'FirstConsultation',
      });

      const ioRef = getChatIO();
      if (ioRef) {
        ioRef.to(`user:${patientId}`).emit('notification.new', {
          id: notif._id,
          title: notif.title,
          message: notif.message,
          type: notif.type,
          referenceId: notif.referenceId?.toString(),
          createdAt: notif.createdAt,
        });
      }

      const patientDoc = await User.findById(patientId).select('deviceTokens').lean();
      const tokens = (patientDoc?.deviceTokens || []).map((t) => t.token);
      await sendPushToTokens(
        tokens,
        {
          title: notif.title,
          body: notif.message,
          data: {
            deepLink: 'docwellness://consultation',
            firstConsultationId: String(consultation._id),
          },
        },
        (deadToken) => {
          User.updateOne(
            { _id: patientId },
            { $pull: { deviceTokens: { token: deadToken } } }
          ).catch(() => {});
        }
      );
    } catch (notifError) {
      console.error('First-consultation review notification error:', notifError);
    }

    res.status(200).json({
      success: true,
      message: 'First consultation saved',
      data: consultation,
    });
  } catch (error) {
    next(error);
  }
};
