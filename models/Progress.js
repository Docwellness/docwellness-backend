const mongoose = require('mongoose');

const progressSchema = new mongoose.Schema(
  {
    patientId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    dieticianId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    date: {
      type: Date,
      required: true,
      default: Date.now,
    },
    weight: {
      type: Number, // in kg
    },
    bmi: {
      type: Number,
    },
    arm: {
      type: Number, // in cm
    },
    waist: {
      type: Number, // in cm
    },
    hip: {
      type: Number, // in cm
    },
    adherence: {
      type: Number, // percentage (0-100)
      min: 0,
      max: 100,
    },
    achieved: {
      type: Boolean,
      default: false,
    },
    notes: {
      type: String,
      trim: true,
    },
    bodyImage: {
      type: String, // URL - body image 1 (e.g. front view) from daily log
    },
    bodyImage2: {
      type: String, // URL - body image 2 (e.g. side view) from daily log
    },
    beforeImage: {
      type: String, // URL (legacy / manual override)
    },
    afterImage: {
      type: String, // URL (legacy / manual override)
    },
  },
  {
    timestamps: true,
  }
);

// Index for efficient querying
progressSchema.index({ patientId: 1, date: -1 });

module.exports = mongoose.model('Progress', progressSchema);
