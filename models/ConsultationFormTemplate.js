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
 *  - file       : file upload (lab reports only - not settable via the
 *                 dietician-facing builder, see consultationFormController.js)
 *
 * A dietician's template starts out pre-populated with the DocWellness
 * standard questionnaire (utils/consultationFormSeed.js) the first time they
 * open "First Consultation" - see getMyTemplate. They can edit/reorder/add to
 * it afterward via "Customize Consultation".
 */
const consultationFormFieldSchema = new mongoose.Schema(
  {
    fieldId: { type: String, required: true },
    type: {
      type: String,
      enum: ['text', 'textarea', 'number', 'date', 'yesNo', 'singleChoice', 'multiChoice', 'file'],
      required: true,
    },
    label: { type: String, required: true, trim: true },
    options: { type: [String], default: [] },
    required: { type: Boolean, default: false },
    order: { type: Number, default: 0 },
    // Groups consecutive fields under one section header on render, e.g.
    // "3. Anthropometry & Weight History". Empty string = ungrouped.
    section: { type: String, default: '' },
    // Controls visibility against the patient's gender.
    genderScope: { type: String, enum: ['general', 'female', 'male'], default: 'general' },
    // Conditional visibility: this field only shows once the referenced
    // field's answer matches one of dependsOnValues (e.g. an "Other, please
    // specify" follow-up field).
    dependsOnFieldId: { type: String, default: null },
    dependsOnValues: { type: [String], default: [] },
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
