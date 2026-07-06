const { ManualPaymentProof } = require('../../models');

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
      .populate('patient', 'profile.fullName username email healthProfile.primaryGoal')
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
