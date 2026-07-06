const mongoose = require('mongoose');

const needAttentionLogSchema = new mongoose.Schema({
  dieticianId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  // date the patient was flagged (just the day, no time)
  flagDate: { type: Date, required: true },
  // true once the dietician has opened/read this patient's profile
  acknowledged: { type: Boolean, default: false },
}, { timestamps: true });

// One entry per (dietician, patient, day)
needAttentionLogSchema.index({ dieticianId: 1, patientId: 1, flagDate: 1 }, { unique: true });
needAttentionLogSchema.index({ dieticianId: 1, flagDate: -1 });

module.exports = mongoose.model('NeedAttentionLog', needAttentionLogSchema);
