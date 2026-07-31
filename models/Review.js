const mongoose = require('mongoose');

const reviewSchema = new mongoose.Schema(
  {
    dieticianId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    patientId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    // Snapshotted at write time (not populated live) so a review still
    // reads sensibly even if the patient later renames their profile.
    patientName: {
      type: String,
      default: 'Docwellness patient',
    },
    rating: {
      type: Number,
      required: true,
      min: 1,
      max: 5,
    },
    text: {
      type: String,
      default: '',
      trim: true,
    },
    // Lower sorts first - set via reviewController.reorderReviews (the
    // dietician's drag-to-reorder). Defaults to insertion time order so
    // newly-submitted reviews land at the end until she reorders them.
    order: {
      type: Number,
      default: () => Date.now(),
    },
  },
  { timestamps: true }
);

// One review per patient per dietician - resubmitting updates it in place
// (see reviewController.addReview) instead of stacking duplicates.
reviewSchema.index({ dieticianId: 1, patientId: 1 }, { unique: true });

module.exports = mongoose.model('Review', reviewSchema);
