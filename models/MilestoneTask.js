const mongoose = require('mongoose');

const milestoneTaskSchema = new mongoose.Schema(
  {
    milestoneId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Milestone',
      required: true,
    },
    title: {
      type: String,
      required: true,
      trim: true,
    },
    metric: {
      type: String,
      trim: true,
    },
    // Key into the client's icon map (e.g. 'water_drop', 'walk') - not a
    // stored asset reference, so new icons need no backend change.
    icon: {
      type: String,
      trim: true,
    },
    sortOrder: {
      type: Number,
      default: 0,
    },
  },
  {
    timestamps: true,
  }
);

milestoneTaskSchema.index({ milestoneId: 1 });

module.exports = mongoose.model('MilestoneTask', milestoneTaskSchema);
