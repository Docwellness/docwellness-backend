const mongoose = require('mongoose');

/**
 * ConsultationFormTemplate
 * One template per dietician. The dietician customizes the set of fields
 * shown on the "First Consultation" screen for ALL their patients.
 *
 * Field types supported:
 *  - text       : single-line text
 *  - textarea   : multi-line text
 *  - number     : numeric input
 *  - date       : date input
 *  - yesNo      : Yes / No toggle
 *  - singleChoice : pick exactly one of `options`
 *  - multiChoice  : pick zero or more of `options`
 */
const consultationFormFieldSchema = new mongoose.Schema(
  {
    fieldId: { type: String, required: true },
    type: {
      type: String,
      enum: ['text', 'textarea', 'number', 'date', 'yesNo', 'singleChoice', 'multiChoice'],
      required: true,
    },
    label: { type: String, required: true, trim: true },
    options: { type: [String], default: [] },
    required: { type: Boolean, default: false },
    order: { type: Number, default: 0 },
  },
  { _id: false }
);

const consultationFormTemplateSchema = new mongoose.Schema(
  {
    dietician: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true,
      index: true,
    },
    fields: { type: [consultationFormFieldSchema], default: [] },
  },
  { timestamps: true }
);

module.exports = mongoose.model(
  'ConsultationFormTemplate',
  consultationFormTemplateSchema
);
