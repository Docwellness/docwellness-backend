const mongoose = require('mongoose');

const goalSchema = new mongoose.Schema(
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
    // The plan this goal was seeded from (see utils/seedGoalTimeline.js) -
    // not required so a goal can outlive the plan it started from (a
    // renewed/replaced plan doesn't reset an in-progress goal).
    dietPlanId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'DietPlan',
    },
    title: {
      type: String,
      required: true,
      trim: true,
    },
    metric: {
      type: String,
      default: 'weight_kg',
    },
    startValue: {
      type: Number,
    },
    currentValue: {
      type: Number,
    },
    targetValue: {
      type: Number,
      required: true,
    },
    unit: {
      type: String,
      default: 'kg',
    },
    startDate: {
      type: Date,
      required: true,
    },
    endDate: {
      type: Date,
      required: true,
    },
    status: {
      type: String,
      enum: ['active', 'paused', 'completed', 'abandoned'],
      default: 'active',
    },
    // Stamped once the goal-missed nudge sweep (see
    // controllers/internal/goalNudgeController.js) has notified this patient
    // that their goal's endDate passed without reaching targetValue - stops
    // the daily cron from re-notifying the same miss every day.
    nudgeSentAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

goalSchema.index({ patientId: 1, status: 1 });

module.exports = mongoose.model('Goal', goalSchema);
