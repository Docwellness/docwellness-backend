const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    title: {
      type: String,
      required: true,
      trim: true,
    },
    message: {
      type: String,
      required: true,
      trim: true,
    },
    type: {
      type: String,
      enum: [
        'diet_plan',
        'payment',
        'chat',
        'progress',
        'system',
        'consultation',
        'membership_renewal',
        'milestone',
        'quote',
      ],
      default: 'system',
    },
    isRead: {
      type: Boolean,
      default: false,
    },
    referenceId: {
      type: mongoose.Schema.Types.ObjectId,
      refPath: 'referenceModel',
    },
    referenceModel: {
      type: String,
      enum: [
        'DietPlan',
        'Payment',
        'Chat',
        'Progress',
        'FirstConsultation',
        'DietPlanRequest',
        'Milestone',
        'Goal',
        'Quote',
      ],
    },
  },
  {
    timestamps: true,
  }
);

// Index for efficient querying
notificationSchema.index({ userId: 1, isRead: 1, createdAt: -1 });

module.exports = mongoose.model('Notification', notificationSchema);
