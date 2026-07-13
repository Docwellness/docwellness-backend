const { FirstConsultation, User } = require('../../models');

const CONSENT_FIELD_ID = 'consent_acknowledgement';
const CONSENT_CONSENT_VALUE = 'I consent';
const SIGNATURE_FIELD_ID = 'consent_signature_name';

/**
 * @desc    Get the patient's own first consultation (as filled in by their
 *          dietician) so they can review it before consenting.
 * @route   GET /api/patient/first-consultation
 * @access  Private (Patient)
 */
exports.getMyFirstConsultation = async (req, res, next) => {
  try {
    const patientId = req.user._id;
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
 * @desc    Patient submits the Consent & Confidentiality section - the only
 *          part of the first consultation they can edit themselves. Patches
 *          just these two customAnswers entries onto whatever the dietician
 *          already filled in (not a full-form replace), then marks
 *          status.patientConsented so the dietician's "Create Diet Plan"
 *          button unlocks.
 * @route   PUT /api/patient/first-consultation/consent
 * @access  Private (Patient)
 * @body    { acknowledged: boolean, signatureName: string }
 */
exports.submitConsent = async (req, res, next) => {
  try {
    const patientId = req.user._id;
    const { acknowledged, signatureName } = req.body || {};
    const trimmedSignature = (signatureName || '').toString().trim();

    if (acknowledged !== true || !trimmedSignature) {
      return res.status(400).json({
        success: false,
        message: 'Both consent and a signature are required.',
      });
    }

    const consultation = await FirstConsultation.findOne({ patient: patientId }).sort({
      createdAt: -1,
    });
    if (!consultation) {
      return res.status(404).json({
        success: false,
        message: 'No first consultation found for this patient yet.',
      });
    }

    const customAnswers = Array.isArray(consultation.customAnswers)
      ? consultation.customAnswers
      : [];

    const setAnswer = (fieldId, label, type, value) => {
      const idx = customAnswers.findIndex((a) => a.fieldId === fieldId);
      const entry = { fieldId, label, type, value };
      if (idx === -1) {
        customAnswers.push(entry);
      } else {
        customAnswers[idx] = entry;
      }
    };

    setAnswer(
      CONSENT_FIELD_ID,
      'I have read and understood the above, and I consent to share this information for my nutrition consultation.',
      'multiChoice',
      [CONSENT_CONSENT_VALUE]
    );
    setAnswer(SIGNATURE_FIELD_ID, 'Signature (type your full name)', 'text', trimmedSignature);

    consultation.customAnswers = customAnswers;
    await consultation.save();

    await User.findByIdAndUpdate(patientId, {
      $set: { 'status.patientConsented': true },
    });

    res.status(200).json({
      success: true,
      message: 'Consent submitted',
      data: consultation,
    });
  } catch (error) {
    next(error);
  }
};
