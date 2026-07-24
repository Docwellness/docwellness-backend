const mongoose = require('mongoose');

const paymentSchema = new mongoose.Schema(
  {
    patientId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    dietPlanId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'DietPlan',
      required: true,
    },
    amount: {
      type: Number,
      required: true,
    },
    currency: {
      type: String,
      default: 'INR',
    },
    razorpayOrderId: {
      type: String,
    },
    razorpayPaymentId: {
      type: String,
    },
    status: {
      type: String,
      enum: ['Pending', 'Completed', 'Failed', 'Refunded'],
      default: 'Pending',
    },
    paymentMethod: {
      type: String,
    },
  },
  {
    timestamps: true,
  }
);

// This model currently has zero live query call sites (confirmed via
// repo-wide search - superseded by ManualPaymentProof + the Razorpay
// verify flow) - added as a sensible baseline for the plan's explicit
// "index Payment" ask, in case/when this model is used again, matching
// the equivalent "history for a patient, most recent first" pattern
// already indexed on Progress/MealLog/Notification.
paymentSchema.index({ patientId: 1, createdAt: -1 });

module.exports = mongoose.model('Payment', paymentSchema);
