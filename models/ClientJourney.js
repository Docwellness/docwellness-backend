const mongoose = require('mongoose');

// A dietician-curated client transformation story: a before/after photo pair
// plus a review (a screenshot/photo OR plain text). Patients of that
// dietician see the before/after on Home and open the full story (with the
// review) in a bottom sheet. Replaces the old JourneyImage model, which was
// patient-uploaded and auto-derived from body logs.
const clientJourneySchema = new mongoose.Schema(
  {
    dieticianId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    // Short label shown under the photos, e.g. "12 weeks · -8 kg".
    title: { type: String, trim: true, default: '' },
    beforeImageUrl: { type: String, required: true },
    beforeImagePublicId: { type: String, default: '' },
    afterImageUrl: { type: String, required: true },
    afterImagePublicId: { type: String, default: '' },
    // The review is either an image or text (or neither) - never both.
    reviewType: { type: String, enum: ['none', 'image', 'text'], default: 'none' },
    reviewImageUrl: { type: String, default: '' },
    reviewImagePublicId: { type: String, default: '' },
    reviewText: { type: String, trim: true, default: '' },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model('ClientJourney', clientJourneySchema);
