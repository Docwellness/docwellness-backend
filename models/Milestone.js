const mongoose = require('mongoose');

const milestoneSchema = new mongoose.Schema(
  {
    goalId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Goal',
      required: true,
    },
    type: {
      type: String,
      enum: ['daily', 'weekly', 'monthly', 'end_goal'],
      required: true,
    },
    title: {
      type: String,
      required: true,
      trim: true,
    },
    subtitle: {
      type: String,
      trim: true,
    },
    date: {
      type: Date,
      required: true,
    },
    sortOrder: {
      type: Number,
      required: true,
    },
    // Optional per-milestone target (e.g. a monthly weigh-in target) -
    // distinct from the goal's own overall targetValue.
    targetMetric: {
      type: Number,
    },
    // Set only for a milestone a dietician added/edited manually (see
    // POST/PUT /api/dietician/milestones) - unset for the auto-seeded ones.
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
  },
  {
    timestamps: true,
  }
);

milestoneSchema.index({ goalId: 1, date: 1 });

module.exports = mongoose.model('Milestone', milestoneSchema);
