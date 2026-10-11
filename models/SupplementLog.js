const mongoose = require('mongoose');

// One doc per supplement a patient ticked off on a given day. Logging a
// supplement is optional (it never feeds adherence/streak), so this is a
// plain presence record: exists = taken, deleted = un-logged.
const supplementLogSchema = new mongoose.Schema(
  {
    patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    date: { type: String, required: true }, // "2026-10-11" (YYYY-MM-DD)
    supplementId: { type: String, required: true },
    servingTime: { type: String, required: true },
    timingAnchor: { type: String, enum: ['pre', 'with', 'post'], default: 'with' },
    loggedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

supplementLogSchema.index(
  { patientId: 1, date: 1, supplementId: 1, servingTime: 1, timingAnchor: 1 },
  { unique: true }
);

module.exports = mongoose.model('SupplementLog', supplementLogSchema);
