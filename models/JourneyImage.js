const mongoose = require('mongoose');

const journeyImageSchema = new mongoose.Schema(
  {
    patientId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    dieticianId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    uploadedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    uploadedByRole: {
      type: String,
      enum: ['patient', 'dietician'],
      required: true,
    },
    beforeImageUrl: {
      type: String,
      default: '',
    },
    afterImageUrl: {
      type: String,
      default: '',
    },
    description: {
      type: String,
      trim: true,
      default: '',
    },
    dayLabel: {
      type: String,
      trim: true,
      default: 'Day 1',
    },
  },
  {
    timestamps: true,
  }
);

// Index for efficient querying
journeyImageSchema.index({ patientId: 1, dieticianId: 1, createdAt: -1 });

module.exports = mongoose.model('JourneyImage', journeyImageSchema);
