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
    // Snapshot of the patient's personal info exactly as submitted with this
    // request - deliberately separate from the mutable patient.profile/
    // healthProfile (which can change later), so a request's own "Order
    // Summary" always reflects what was true when it was submitted.
    fullName: { type: String },
    dateOfBirth: { type: String },
    gender: { type: String },
    weight: { type: Number },
    height: { type: Number },
    bmi: { type: Number },
    weightIndex: { type: Number },
    targetWeight: { type: String, default: null },
    activityLevel: { type: String, default: null },
    healthConcerns: { type: [String], default: [] },
    // Membership plan chosen on the Connect for Payment step, set via a
    // separate call after the request itself is created.
    membershipPlan: { type: String, default: null },
    membershipAmount: { type: Number, default: null },
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
