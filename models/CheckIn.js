const mongoose = require('mongoose');

const checkInSchema = new mongoose.Schema(
  {
    patientId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    taskId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'MilestoneTask',
      required: true,
    },
    milestoneId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Milestone',
      required: true,
    },
    value: {
      type: String,
    },
    loggedAt: {
      type: Date,
      default: Date.now,
    },
    // Derived YYYY-MM-DD of loggedAt, computed below - Mongo can't index a
    // date-truncated expression directly, so this is the stored stand-in
    // for "one check-in per task per day" (the Mongo equivalent of the
    // spec's Postgres functional unique index on logged_at::date).
    dateKey: {
      type: String,
    },
  },
  {
    timestamps: true,
  }
);

checkInSchema.pre('validate', function () {
  if (!this.dateKey) {
    const d = this.loggedAt || new Date();
    this.dateKey = d.toISOString().slice(0, 10);
  }
});

checkInSchema.index({ taskId: 1, patientId: 1, dateKey: 1 }, { unique: true });

module.exports = mongoose.model('CheckIn', checkInSchema);
