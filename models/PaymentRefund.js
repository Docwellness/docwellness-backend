const mongoose = require('mongoose');

/**
 * Refund recorded against an approved manual payment
 * (openspec: admin-payments, "Refund log"). A log only: it does not move money
 * or change the patient's subscription.
 */
const PaymentRefundSchema = new mongoose.Schema(
  {
    proof: { type: mongoose.Schema.Types.ObjectId, ref: 'ManualPaymentProof', required: true, index: true },
    patient: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    amount: { type: Number, required: true, min: [0.01, 'The refund must be more than zero'] },
    reason: { type: String, required: true, trim: true, maxlength: 500 },
    refundedAt: { type: Date, required: true },
    reference: { type: String, trim: true, maxlength: 120 },
    recordedBy: { type: String },
  },
  { timestamps: true }
);

module.exports = mongoose.models.PaymentRefund || mongoose.model('PaymentRefund', PaymentRefundSchema);
