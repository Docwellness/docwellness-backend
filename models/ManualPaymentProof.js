const mongoose = require('mongoose');

const manualPaymentProofSchema = new mongoose.Schema(
  {
    request: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'DietPlanRequest',
      required: true,
    },
    patient: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    amountReceived: {
      type: Number,
      required: true,
      min: [0, 'Amount received cannot be negative'],
    },
    amountPending: {
      type: Number,
      required: true,
      min: [0, 'Amount pending cannot be negative'],
    },
    totalAmount: {
      type: Number,
    },
    description: {
      type: String,
      trim: true,
      maxlength: 500,
    },
    proofImage: {
      type: String,
    },
    status: {
      type: String,
      enum: ['Submitted', 'Reviewed', 'Approved', 'Rejected'],
      default: 'Submitted',
    },
    reviewedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    reviewedAt: {
      type: Date,
    },
    reviewNote: {
      type: String,
      trim: true,
      maxlength: 500,
    },
    couponCode: {
      type: String,
      trim: true,
      default: null,
    },
    discountPercentage: {
      type: Number,
      default: null,
    },
    originalAmount: {
      type: Number,
      default: null,
    },
    // Only meaningful when amountPending > 0 - when the patient expects to
    // clear the remaining balance, so the dietician isn't left guessing.
    pendingPaymentDate: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

// AI_EXECUTION_PLAN.md Phase 3, P3-01 - patient+status is the actual query
// shape used by getManualPaymentProofs (dietician's proof-review list,
// defaults to status:'Submitted'); request is queried alone (the
// pay-remaining-balance aggregation in patientController.js's
// getPatientProfile, dashboardController's revenue aggregations).
manualPaymentProofSchema.index({ patient: 1, status: 1 });
manualPaymentProofSchema.index({ request: 1 });

manualPaymentProofSchema.pre('save', function () {
  if (typeof this.amountReceived === 'number' && typeof this.amountPending === 'number') {
    this.totalAmount = this.amountReceived + this.amountPending;
  }
});

module.exports = mongoose.model('ManualPaymentProof', manualPaymentProofSchema);
