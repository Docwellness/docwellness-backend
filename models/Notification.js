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
        'meal_reminder',
        'water_reminder',
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
    // Free-form extras the tapping client needs that don't fit referenceId
    // (which is a single ObjectId) - e.g. a dietician-facing renewal
    // notification carries { patientId } so the bell-list tap can open that
    // patient's profile, not just the referenced DietPlanRequest.
    data: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

// Index for efficient querying
notificationSchema.index({ userId: 1, isRead: 1, createdAt: -1 });

module.exports = mongoose.model('Notification', notificationSchema);
