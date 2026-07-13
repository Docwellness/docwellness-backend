const { ConsultationFormTemplate } = require('../../models');
const { DEFAULT_CONSULTATION_FORM_FIELDS } = require('../../utils/consultationFormSeed');
const config = require('../../config/environment');

const ALLOWED_TYPES = [
  'text',
  'textarea',
  'number',
  'date',
  'yesNo',
  'singleChoice',
  'multiChoice',
  'file',
];

/**
 * @desc    Get the dietician's own consultation form template. The first
 *          time a dietician with no template fetches it, the DocWellness
 *          standard questionnaire is seeded and persisted as their default
 *          (editable afterward via upsertMyTemplate) - a dietician who has
 *          already built their own template is never touched.
 * @route   GET /api/dietician/consultation-form
 * @access  Private (Dietician)
 */
exports.getMyTemplate = async (req, res, next) => {
  try {
    const dieticianId = req.user._id;
    const template = await ConsultationFormTemplate.findOneAndUpdate(
      { dietician: dieticianId },
      { $setOnInsert: { dietician: dieticianId, fields: DEFAULT_CONSULTATION_FORM_FIELDS } },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );

    res.status(200).json({ success: true, data: template });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Create or replace the dietician's consultation form template.
 *          Body: { fields: [{ fieldId, type, label, options[], required, order }] }
 * @route   PUT /api/dietician/consultation-form
 * @access  Private (Dietician)
 */
exports.upsertMyTemplate = async (req, res, next) => {
  try {
    const dieticianId = req.user._id;
    const incomingFields = Array.isArray(req.body?.fields) ? req.body.fields : [];

    // 'file' fields (lab report upload) aren't supported by the "Customize
    // Consultation" builder UI - there's no picker/upload wiring for a
    // dietician-authored one, and no defined contract for what its
    // customAnswers value would even mean. Only allow a 'file' field through
    // if it's an untouched pass-through of one that already exists on this
    // dietician's stored template (i.e. the seeded lab-report field surviving
    // a save), never a newly authored one.
    const existingTemplate = await ConsultationFormTemplate.findOne({ dietician: dieticianId });
    const existingFileFieldIds = new Set(
      (existingTemplate?.fields || []).filter((f) => f.type === 'file').map((f) => f.fieldId)
    );

    // Validate + normalize each field
    const cleaned = [];
    for (let i = 0; i < incomingFields.length; i++) {
      const f = incomingFields[i] || {};
      const type = String(f.type || '').trim();
      const label = String(f.label || '').trim();

      if (!ALLOWED_TYPES.includes(type)) {
        return res.status(400).json({
          success: false,
          message: `Invalid field type "${type}" at index ${i}`,
        });
      }
      if (type === 'file' && !existingFileFieldIds.has(String(f.fieldId || '').trim())) {
        return res.status(400).json({
          success: false,
          message: `Field type "file" cannot be added from the consultation form builder`,
        });
      }
      if (!label) {
        return res.status(400).json({
          success: false,
          message: `Field at index ${i} requires a label`,
        });
      }

      const needsOptions = type === 'singleChoice' || type === 'multiChoice';
      const options = Array.isArray(f.options)
        ? f.options.map((o) => String(o).trim()).filter(Boolean)
        : [];
      if (needsOptions && options.length === 0) {
        return res.status(400).json({
          success: false,
          message: `Field "${label}" requires at least one option`,
        });
      }

      const genderScope = ['general', 'female', 'male'].includes(f.genderScope)
        ? f.genderScope
        : 'general';
      const dependsOnFieldId = (f.dependsOnFieldId && String(f.dependsOnFieldId).trim()) || null;
      const dependsOnValues = Array.isArray(f.dependsOnValues)
        ? f.dependsOnValues.map(String)
        : [];

      cleaned.push({
        fieldId:
          (f.fieldId && String(f.fieldId).trim()) ||
          `${Date.now()}-${i}-${Math.random().toString(36).slice(2, 8)}`,
        type,
        label,
        options: needsOptions ? options : [],
        required: Boolean(f.required),
        order: Number.isFinite(f.order) ? Number(f.order) : i,
        section: String(f.section || '').trim(),
        genderScope,
        dependsOnFieldId,
        dependsOnValues,
      });
    }

    // Drop dangling dependsOnFieldId references (e.g. the referenced field
    // was removed in this same save) rather than blocking the save - the
    // builder UI doesn't expose these properties for editing yet, so a
    // dietician has no way to fix a validation error about them.
    const cleanedIds = new Set(cleaned.map((f) => f.fieldId));
    cleaned.forEach((f) => {
      if (f.dependsOnFieldId && !cleanedIds.has(f.dependsOnFieldId)) {
        f.dependsOnFieldId = null;
        f.dependsOnValues = [];
      }
    });

    const template = await ConsultationFormTemplate.findOneAndUpdate(
      { dietician: dieticianId },
      { dietician: dieticianId, fields: cleaned },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );

    res.status(200).json({
      success: true,
      message: 'Consultation form template saved',
      data: template,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Patient endpoint: get the consultation form template configured by
 *          the dietician currently assigned to the patient (or an empty one).
 * @route   GET /api/patient/consultation-form
 * @access  Private (Patient)
 *
 * NOTE: Mounted under the patient routes if/when the patient app needs to
 * render the same form. Exported here for reuse.
 */
exports.getTemplateForDietician = async (req, res, next) => {
  try {
    const { dieticianId } = req.params;
    const template = await ConsultationFormTemplate.findOne({
      dietician: dieticianId,
    });

    res.status(200).json({
      success: true,
      data: template || { dietician: dieticianId, fields: [] },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Patient endpoint: get the consultation form template for the
 *          patient's own (single, default) assigned dietician - same data
 *          as getTemplateForDietician, resolved without a URL param since
 *          every patient shares the one default dietician in this app.
 * @route   GET /api/patient/consultation-form-template
 * @access  Private (Patient)
 */
exports.getTemplateForPatient = async (req, res, next) => {
  try {
    const dieticianId = config.defaultDieticianId;
    const template = await ConsultationFormTemplate.findOne({
      dietician: dieticianId,
    });

    res.status(200).json({
      success: true,
      data: template || { dietician: dieticianId, fields: [] },
    });
  } catch (error) {
    next(error);
  }
};
