const mongoose = require('mongoose');

const dietPlanRequestSchema = new mongoose.Schema(
  {
    patient: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    dieticianId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    startDateForDiet: {
      type: Date,
      required: true,
    },
    primaryGoal: {
      type: String,
    },
    status: {
      type: String,
      enum: ['Unpaid', 'PaymentRequested', 'PaymentSubmitted', 'Paid'],
      default: 'Unpaid',
    },
    paymentRequested: {
      type: Boolean,
      default: false,
    },
    paymentRequestedAt: {
      type: Date,
      default: null,
    },
    plansCount: { type: Number, default: 0 },
    hasActivePlan: { type: Boolean, default: false },
    latestPaymentStatus: {
      type: String,
      enum: ['Paid', 'Pending', null],
      default: null,
    },
    latestPaymentProof: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ManualPaymentProof',
    },
    collectedAmount: {
      type: Number,
      default: 0,
      min: [0, 'Collected amount cannot be negative'],
    },
    completedAt: {
      type: Date,
      default: null,
    },
    subscriptionStartDate: {
      type: Date,
      default: null,
    },
    subscriptionExpiresAt: {
      type: Date,
      default: null,
    },
    currentWeight: {
      type: Number,
      default: null,
    },
    totalKgLost: {
      type: Number,
      default: null,
    },
    bmiFrom: {
      type: Number,
      default: null,
    },
    bmiTo: {
      type: Number,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model('DietPlanRequest', dietPlanRequestSchema);
