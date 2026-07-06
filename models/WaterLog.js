const mongoose = require('mongoose');

const waterEntrySchema = new mongoose.Schema({
  amount: { type: Number, required: true }, // in ml
  time: { type: String, required: true }, // "14:30"
  timestamp: { type: Date, default: Date.now },
});

const waterLogSchema = new mongoose.Schema(
  {
    patientId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    date: {
      type: String, // "2026-02-27" (YYYY-MM-DD)
      required: true,
    },
    goal: {
      type: Number, // daily goal in ml
      default: 2500,
    },
    totalAmount: {
      type: Number, // total ml consumed that day
      default: 0,
    },
    entries: [waterEntrySchema],
  },
  { timestamps: true }
);

// One log per patient per day
waterLogSchema.index({ patientId: 1, date: 1 }, { unique: true });

module.exports = mongoose.model('WaterLog', waterLogSchema);
