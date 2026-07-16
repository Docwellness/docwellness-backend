/**
 * Patient Payment Controller
 * Handles payment operations for patients
 */

const fs = require('fs/promises');
const mongoose = require('mongoose');
const { ManualPaymentProof, DietPlanRequest, User } = require('../../models');
const cloudinary = require('../../config/cloudinary');
const { cloudinaryUserFolder } = require('../../utils/cloudinaryFolder');


/**
 * @desc    Submit manual payment proof
 * @route   POST /api/patient/payments/manual-proof
 * @access  Private (Patient)
 */
exports.submitManualPaymentProof = async (req, res, next) => {
  try {
    const { amountReceived, amountPending, description, requestId, couponCode, discountPercentage, originalAmount, pendingPaymentDate } = req.body;

    if (!requestId) {
      return res.status(400).json({
        success: false,
        message: 'requestId is required',
      });
    }

    if (!mongoose.Types.ObjectId.isValid(requestId)) {
      return res.status(400).json({
        success: false,
        message: 'requestId must be a valid identifier',
      });
    }

    const parsedAmountReceived = Number(amountReceived);
    const parsedAmountPending = Number(amountPending);

    if (Number.isNaN(parsedAmountReceived) || Number.isNaN(parsedAmountPending)) {
      return res.status(400).json({
        success: false,
        message: 'Amounts must be valid numbers',
      });
    }

    const dietPlanRequest = await DietPlanRequest.findById(requestId);

    if (!dietPlanRequest) {
      return res.status(404).json({
        success: false,
        message: 'Diet plan request not found',
      });
    }

    if (dietPlanRequest.patient.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        message: 'You cannot submit proof for this request',
      });
    }

    let proofImagePath = null;
    if (req.file?.path) {
      const uploadResult = await cloudinary.uploader.upload(req.file.path, {
        folder: cloudinaryUserFolder(req.user._id, 'payments'),
      });
      await fs.unlink(req.file.path).catch(() => { });
      proofImagePath = uploadResult.secure_url;
    }

    const proofData = {
      request: requestId,
      patient: req.user._id,
      amountReceived: parsedAmountReceived,
      amountPending: parsedAmountPending,
      description,
      proofImage: proofImagePath,
    };

    // Attach coupon info if provided
    if (couponCode) proofData.couponCode = couponCode;
    if (discountPercentage) proofData.discountPercentage = Number(discountPercentage);
    if (originalAmount) proofData.originalAmount = Number(originalAmount);

    // Only meaningful when there's still a balance left to pay
    if (parsedAmountPending > 0 && pendingPaymentDate) {
      const parsedDate = new Date(pendingPaymentDate);
      if (!Number.isNaN(parsedDate.getTime())) {
        proofData.pendingPaymentDate = parsedDate;
      }
    }

    const proof = await ManualPaymentProof.create(proofData);

    dietPlanRequest.latestPaymentProof = proof._id;
    dietPlanRequest.status = 'PaymentSubmitted';
    dietPlanRequest.latestPaymentStatus = 'Pending';
    await dietPlanRequest.save({ validateBeforeSave: false });

    await User.findByIdAndUpdate(
      req.user._id,
      {
        $set: {
          'status.requestId': dietPlanRequest._id,
          'status.requestStatus': 'PaymentSubmitted',
          'status.hasPaymentUpdate': true,
          'status.canSendPaymentRequest': false,
        },
      },
      { new: false }
    );

    res.status(201).json({
      success: true,
      message: 'Payment proof submitted successfully. A dietician will review it shortly.',
      data: {
        id: proof._id,
        requestId: proof.request,
        amountReceived: proof.amountReceived,
        amountPending: proof.amountPending,
        totalAmount: proof.totalAmount,
        description: proof.description,
        pendingPaymentDate: proof.pendingPaymentDate,
        status: proof.status,
        proofImage: proof.proofImage,
        createdAt: proof.createdAt,
      },
    });
  } catch (error) {
    next(error);
  }
};
