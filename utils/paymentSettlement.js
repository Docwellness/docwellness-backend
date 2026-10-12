const { User } = require('../models');

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MEMBERSHIP_DAYS = 30;

/**
 * Settles a renewal payment: approves the proof and updates the diet plan
 * request and the patient's status flags. Used by BOTH the dietician's
 * confirm endpoint and the admin panel's, so the two can never drift apart.
 *
 * Callers must already have checked that the proof is in `Submitted` status
 * and that the patient has an active plan (a renewal). Does not check access.
 *
 * @param {{proof: object, request: object, patientId: any, reviewerId: any, now?: Date}} args
 */
async function settleRenewalProof({ proof, request, patientId, reviewerId, now = new Date() }) {
  proof.status = 'Approved';
  proof.reviewedBy = reviewerId;
  proof.reviewedAt = now;
  await proof.save();

  // Same settlement fields activateDietPlan sets for a fresh activation -
  // just applied directly to the request, with no DietPlan to touch.
  const amountPending = proof.amountPending || 0;
  request.status = amountPending > 0 ? 'PartiallyPaid' : 'Paid';
  request.hasActivePlan = true;
  request.latestPaymentStatus = amountPending > 0 ? 'Pending' : 'Paid';
  request.latestPaymentProof = proof._id;
  request.collectedAmount = proof.amountReceived || 0;
  request.subscriptionStartDate = now;
  request.subscriptionExpiresAt = new Date(now.getTime() + MEMBERSHIP_DAYS * MS_PER_DAY);
  await request.save();

  // Clear the same User.status flags activateDietPlan clears on a fresh
  // activation - otherwise the "Payment Update Received" card on the profile
  // keeps showing (it's gated on hasPaymentUpdate, not on request.status)
  // even though there's nothing left to review.
  await User.findByIdAndUpdate(patientId, {
    $set: {
      'status.requestStatus': request.status,
      'status.hasPaymentUpdate': false,
      'status.canSendPaymentRequest': false,
      'status.subscriptionExpiresAt': request.subscriptionExpiresAt,
    },
  });

  return { proof, request };
}

module.exports = { settleRenewalProof, MEMBERSHIP_DAYS };
