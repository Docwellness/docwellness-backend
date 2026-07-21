const { ManualPaymentProof, DietPlan, DietPlanRequest, User } = require('../../models');

/**
 * @desc    List manual payment proofs submitted by patients
 * @route   GET /api/dietician/payments/manual-proofs
 * @access  Private (Dietician)
 */
exports.getManualPaymentProofs = async (req, res, next) => {
  try {
    const { status = 'Submitted' } = req.query;
    const { patientId } = req.params;

    const query = {
      patient: patientId,
      ...(status ? { status } : {}),
    };

    const proofs = await ManualPaymentProof.find(query)
      .populate('patient', 'profile.fullName email healthProfile.primaryGoal')
      .populate('request', 'startDateForDiet status')
      .sort({ createdAt: -1 });

    res.status(200).json({
      success: true,
      data: proofs.map((proof) => ({
        id: proof._id,
        patientId: proof.patient?._id || null,
        patientName: proof.patient?.profile?.fullName || null,
        amountReceived: proof.amountReceived,
        amountPending: proof.amountPending,
        totalAmount: proof.totalAmount,
        description: proof.description,
        proofImage: proof.proofImage,
        status: proof.status,
        couponCode: proof.couponCode || null,
        discountPercentage: proof.discountPercentage || null,
        originalAmount: proof.originalAmount || null,
      })),
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Reject a manual payment proof
 * @route   PUT /api/dietician/patients/:patientId/payments/manual-proofs/:proofId/reject
 * @access  Private (Dietician)
 */
exports.rejectPaymentProof = async (req, res, next) => {
  try {
    const { proofId } = req.params;
    const { reviewNote } = req.body;

    const proof = await ManualPaymentProof.findById(proofId);

    if (!proof) {
      return res.status(404).json({
        success: false,
        message: 'Payment proof not found',
      });
    }

    if (proof.status === 'Rejected') {
      return res.status(400).json({
        success: false,
        message: 'Payment proof is already rejected',
      });
    }

    proof.status = 'Rejected';
    proof.reviewedBy = req.user._id;
    proof.reviewedAt = new Date();
    proof.reviewNote = reviewNote || '';

    await proof.save();

    res.status(200).json({
      success: true,
      message: 'Payment proof rejected successfully',
      data: {
        id: proof._id,
        status: proof.status,
        reviewNote: proof.reviewNote,
        reviewedAt: proof.reviewedAt,
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Approve a manual payment proof for a patient who already has an
 *          active diet plan (renewal) - settles the bill directly, without
 *          requiring a new diet plan to be built/finalized/activated, since
 *          there's nothing about the plan itself that needs to change.
 * @route   PUT /api/dietician/patients/:patientId/payments/manual-proofs/:proofId/confirm
 * @access  Private (Dietician)
 */
exports.confirmRenewalPayment = async (req, res, next) => {
  try {
    const { patientId, proofId } = req.params;

    const proof = await ManualPaymentProof.findById(proofId);

    if (!proof) {
      return res.status(404).json({
        success: false,
        message: 'Payment proof not found',
      });
    }

    if (proof.status !== 'Submitted') {
      return res.status(400).json({
        success: false,
        message: 'Payment proof must be in Submitted status before confirming',
      });
    }

    // This shortcut only makes sense when the patient already has a usable
    // active plan (a renewal payment) - if not, there's no plan for the
    // patient to actually use once "Paid", so route the dietician through
    // the normal build/finalize/activate flow instead.
    const hasActivePlan = await DietPlan.exists({
      patientId,
      status: 'Active',
    });
    if (!hasActivePlan) {
      return res.status(400).json({
        success: false,
        message:
          'No active diet plan found for this patient. Build and activate a diet plan first.',
      });
    }

    const request = await DietPlanRequest.findById(proof.request);
    if (!request) {
      return res.status(404).json({
        success: false,
        message: 'Diet plan request not found for this payment proof',
      });
    }

    proof.status = 'Approved';
    proof.reviewedBy = req.user._id;
    proof.reviewedAt = new Date();
    await proof.save();

    // Same settlement fields activateDietPlan sets for a fresh activation -
    // just applied directly to the request, with no DietPlan to touch.
    const amountPending = proof.amountPending || 0;
    request.status = amountPending > 0 ? 'PartiallyPaid' : 'Paid';
    request.hasActivePlan = true;
    request.latestPaymentStatus = amountPending > 0 ? 'Pending' : 'Paid';
    request.latestPaymentProof = proof._id;
    request.collectedAmount = proof.amountReceived || 0;

    const now = new Date();
    request.subscriptionStartDate = now;
    request.subscriptionExpiresAt = new Date(
      now.getTime() + 30 * 24 * 60 * 60 * 1000
    );

    await request.save();

    // Clear the same User.status flags activateDietPlan clears on a fresh
    // activation - otherwise the "Payment Update Received" card on the
    // profile keeps showing (it's gated on hasPaymentUpdate, not on
    // request.status) even though there's nothing left to review.
    await User.findByIdAndUpdate(patientId, {
      $set: {
        'status.requestStatus': request.status,
        'status.hasPaymentUpdate': false,
        'status.canSendPaymentRequest': false,
        'status.subscriptionExpiresAt': request.subscriptionExpiresAt,
      },
    });

    res.status(200).json({
      success: true,
      message: 'Payment confirmed and bill settled successfully',
      data: {
        proofId: proof._id,
        proofStatus: proof.status,
        requestStatus: request.status,
        subscriptionExpiresAt: request.subscriptionExpiresAt,
      },
    });
  } catch (error) {
    next(error);
  }
};
