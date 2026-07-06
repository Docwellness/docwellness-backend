const { ConsultationFormTemplate } = require('../../models');

const ALLOWED_TYPES = [
  'text',
  'textarea',
  'number',
  'date',
  'yesNo',
  'singleChoice',
  'multiChoice',
];

/**
 * @desc    Get the dietician's own consultation form template.
 *          Returns an empty template if none exists yet.
 * @route   GET /api/dietician/consultation-form
 * @access  Private (Dietician)
 */
exports.getMyTemplate = async (req, res, next) => {
  try {
    const dieticianId = req.user._id;
    let template = await ConsultationFormTemplate.findOne({
      dietician: dieticianId,
    });

    if (!template) {
      template = { dietician: dieticianId, fields: [] };
    }

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

      cleaned.push({
        fieldId:
          (f.fieldId && String(f.fieldId).trim()) ||
          `${Date.now()}-${i}-${Math.random().toString(36).slice(2, 8)}`,
        type,
        label,
        options: needsOptions ? options : [],
        required: Boolean(f.required),
        order: Number.isFinite(f.order) ? Number(f.order) : i,
      });
    }

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
