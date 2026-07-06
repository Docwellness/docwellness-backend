const { DietPlanRequest, User, ManualPaymentProof } = require('../../models');
const { normalizeHealthProfileNumbers } = require('../../utils/healthProfileUtils');

/**
 * @desc    Create a diet plan request for the logged-in patient
 * @route   POST /api/patient/diet-plan-requests
 * @access  Private (Patient)
 */
exports.createDietPlanRequest = async (req, res, next) => {
  try {
    const { startDateForDiet, fullName, dateOfBirth, gender, weight, height, bmi, weightIndex } =
      req.body || {};

    const metricsPayload = { weight, height, bmi, weightIndex };
    normalizeHealthProfileNumbers(metricsPayload);

    if (!startDateForDiet) {
      return res.status(400).json({
        success: false,
        message: 'startDateForDiet is required',
      });
    }

    const parsedDate = new Date(startDateForDiet);
    if (Number.isNaN(parsedDate.getTime())) {
      return res.status(400).json({
        success: false,
        message: 'startDateForDiet must be a valid date',
      });
    }

    const patient = await User.findById(req.user._id);

    if (!patient) {
      return res.status(404).json({
        success: false,
        message: 'Patient not found',
      });
    }

    if (!patient.profile) patient.profile = {};
    if (!patient.healthProfile) patient.healthProfile = {};

    if (fullName && fullName !== patient.profile.fullName) {
      patient.profile.fullName = fullName;
    }

    if (dateOfBirth && dateOfBirth !== patient.profile.dateOfBirth) {
      patient.profile.dateOfBirth = dateOfBirth;
    }

    if (gender && gender !== patient.profile.gender) {
      patient.profile.gender = gender;
    }

    if (
      metricsPayload.weight !== undefined &&
      metricsPayload.weight !== patient.healthProfile.weight
    ) {
      patient.healthProfile.weight = metricsPayload.weight;
    }

    if (
      metricsPayload.height !== undefined &&
      metricsPayload.height !== patient.healthProfile.height
    ) {
      patient.healthProfile.height = metricsPayload.height;
    }

    if (metricsPayload.bmi !== undefined && metricsPayload.bmi !== patient.healthProfile.bmi) {
      patient.healthProfile.bmi = metricsPayload.bmi;
    }

    if (
      metricsPayload.weightIndex !== undefined &&
      metricsPayload.weightIndex !== patient.healthProfile.weightIndex
    ) {
      patient.healthProfile.weightIndex = metricsPayload.weightIndex;
    }

    await patient.save();

    const primaryGoal = patient.healthProfile?.primaryGoal || null;

    const request = await DietPlanRequest.create({
      patient: patient._id,
      dieticianId: process.env.DEFAULT_DIETICIAN_ID,
      startDateForDiet: parsedDate,
      primaryGoal,
      status: 'Unpaid',
    });

    res.status(201).json({
      success: true,
      data: {
        requestId: request._id,
        startDateForDiet: request.startDateForDiet,
        primaryGoal: request.primaryGoal,
        status: request.status,
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Get the latest diet plan request status for the logged-in patient
 * @route   GET /api/patient/diet-plan-requests/status
 * @access  Private (Patient)
 */
exports.getRequestStatus = async (req, res, next) => {
  try {
    const patientId = req.user._id;

    // Find the most recent diet plan request for this patient
    const latestRequest = await DietPlanRequest.findOne({ patient: patientId })
      .sort({ createdAt: -1 })
      .select(
        'status paymentRequested paymentRequestedAt createdAt startDateForDiet primaryGoal latestPaymentProof subscriptionStartDate subscriptionExpiresAt'
      );

    let latestProof = null;
    if (latestRequest?.latestPaymentProof) {
      latestProof = await ManualPaymentProof.findById(latestRequest.latestPaymentProof)
        .select('amountReceived amountPending totalAmount status')
        .lean();
    }

    if (!latestRequest) {
      return res.status(200).json({
        success: true,
        data: {
          hasRequest: false,
          status: null,
          message: 'No diet plan request found',
        },
      });
    }

    res.status(200).json({
      success: true,
      data: {
        hasRequest: true,
        requestId: latestRequest._id,
        status: latestRequest.status,
        paymentRequested: latestRequest.paymentRequested || false,
        paymentRequestedAt: latestRequest.paymentRequestedAt || null,
        startDateForDiet: latestRequest.startDateForDiet,
        primaryGoal: latestRequest.primaryGoal,
        createdAt: latestRequest.createdAt,
        paymentSummary: latestProof
          ? {
            amountReceived: latestProof.amountReceived ?? 0,
            amountPending: latestProof.amountPending ?? 0,
            totalAmount: latestProof.totalAmount ?? 0,
            proofStatus: latestProof.status || null,
          }
          : null,
        subscriptionStartDate: latestRequest.subscriptionStartDate || null,
        subscriptionExpiresAt: latestRequest.subscriptionExpiresAt || null,
      },
    });
  } catch (error) {
    next(error);
  }
};
