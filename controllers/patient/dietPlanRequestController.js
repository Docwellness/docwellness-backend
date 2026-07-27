const { DietPlanRequest, User, ManualPaymentProof } = require('../../models');
const { normalizeHealthProfileNumbers } = require('../../utils/healthProfileUtils');
const { parseFlexibleDate } = require('../../utils/dateUtils');

/**
 * @desc    Create a diet plan request for the logged-in patient
 * @route   POST /api/patient/diet-plan-requests
 * @access  Private (Patient)
 */
exports.createDietPlanRequest = async (req, res, next) => {
  try {
    const {
      startDateForDiet,
      fullName,
      dateOfBirth,
      gender,
      weight,
      height,
      bmi,
      weightIndex,
      targetWeight,
      activityLevel,
      healthConcerns,
      primaryGoal: requestedPrimaryGoal,
    } = req.body || {};

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
      // dateOfBirth flows into a Date-typed field (User.profile.dateOfBirth)
      // - assigning the raw string directly crashed with a Mongoose
      // CastError in production for values Date's own naive cast can't
      // parse (e.g. "15-05-1994"). parseFlexibleDate accepts either the
      // DD-MM-YYYY wire format used elsewhere in this API or a plain ISO
      // string, and never throws.
      const parsedDob = parseFlexibleDate(dateOfBirth);
      if (parsedDob) {
        patient.profile.dateOfBirth = parsedDob;
      }
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

    if (targetWeight !== undefined && targetWeight !== patient.healthProfile.targetWeight) {
      patient.healthProfile.targetWeight = targetWeight;
    }

    if (activityLevel !== undefined && activityLevel !== patient.healthProfile.activityLevel) {
      patient.healthProfile.activityLevel = activityLevel;
    }

    if (Array.isArray(healthConcerns)) {
      patient.healthProfile.healthConcerns = healthConcerns;
    }

    if (
      requestedPrimaryGoal !== undefined &&
      requestedPrimaryGoal !== patient.healthProfile.primaryGoal
    ) {
      patient.healthProfile.primaryGoal = requestedPrimaryGoal;
    }

    await patient.save();

    const primaryGoal = requestedPrimaryGoal ?? patient.healthProfile?.primaryGoal ?? null;

    // Snapshot fields - what "Order Summary" reads back, independent of
    // whatever the mutable patient profile looks like later.
    const snapshot = {
      startDateForDiet: parsedDate,
      primaryGoal,
      fullName: patient.profile.fullName,
      dateOfBirth: patient.profile.dateOfBirth,
      gender: patient.profile.gender,
      weight: metricsPayload.weight,
      height: metricsPayload.height,
      bmi: metricsPayload.bmi,
      weightIndex: metricsPayload.weightIndex,
      targetWeight: targetWeight ?? patient.healthProfile.targetWeight ?? null,
      activityLevel: activityLevel ?? patient.healthProfile.activityLevel ?? null,
      healthConcerns: Array.isArray(healthConcerns)
        ? healthConcerns
        : patient.healthProfile.healthConcerns || [],
    };

    // "Update Plan Request" (Order Summary -> edit -> re-submit) re-posts to
    // this same endpoint - while the request is still Unpaid (no payment
    // request sent yet), that resubmission should overwrite the existing
    // request rather than create a new one, or every edit piles up another
    // duplicate row in the dietician's "All Patient Requests" list.
    let request = await DietPlanRequest.findOne({
      patient: patient._id,
      status: 'Unpaid',
    }).sort({ createdAt: -1 });

    if (request) {
      Object.assign(request, snapshot);
      await request.save();
    } else {
      request = await DietPlanRequest.create({
        patient: patient._id,
        dieticianId: process.env.DEFAULT_DIETICIAN_ID,
        status: 'Unpaid',
        ...snapshot,
      });
    }

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
 * @desc    Set the membership plan chosen for a diet plan request
 * @route   PATCH /api/patient/diet-plan-requests/:id/plan
 * @access  Private (Patient)
 */
exports.selectMembershipPlan = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { membershipPlan, membershipAmount } = req.body || {};

    if (!membershipPlan || membershipAmount === undefined || membershipAmount === null) {
      return res.status(400).json({
        success: false,
        message: 'membershipPlan and membershipAmount are required',
      });
    }

    const amount = Number(membershipAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({
        success: false,
        message: 'membershipAmount must be a positive number',
      });
    }

    const request = await DietPlanRequest.findOne({ _id: id, patient: req.user._id });

    if (!request) {
      return res.status(404).json({
        success: false,
        message: 'Diet plan request not found',
      });
    }

    request.membershipPlan = membershipPlan;
    request.membershipAmount = amount;
    await request.save();

    res.status(200).json({
      success: true,
      data: {
        requestId: request._id,
        membershipPlan: request.membershipPlan,
        membershipAmount: request.membershipAmount,
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Start a renewal cycle on an existing (already-activated) diet
 *          plan request - resets its payment/status fields on the SAME
 *          document so the patient can pick a plan again and the dietician
 *          can build a fresh diet plan, without redoing the intake form or
 *          first consultation (their data already exists).
 *
 *          Deliberately reuses this document rather than creating a new
 *          DietPlanRequest: listPatientsForDietician queries one row per
 *          request, not deduped per patient, so a second request would make
 *          the patient appear twice on the dietician's dashboard. The
 *          resulting Unpaid + hasActivePlan:true combination is handled by
 *          the "ongoing" tab filter (see listPatientsForDietician).
 *
 *          membershipPlan/membershipAmount and subscriptionStartDate/
 *          subscriptionExpiresAt are intentionally left untouched here - the
 *          patient re-picks a plan next via selectMembershipPlan, and the
 *          old cycle's real expiry stays visible/correct until the new
 *          cycle's activateDietPlan overwrites it.
 * @route   POST /api/patient/diet-plan-requests/:id/renew
 * @access  Private (Patient)
 */
exports.startRenewal = async (req, res, next) => {
  try {
    const { id } = req.params;

    const request = await DietPlanRequest.findOne({ _id: id, patient: req.user._id });

    if (!request) {
      return res.status(404).json({
        success: false,
        message: 'Diet plan request not found',
      });
    }

    if (!request.hasActivePlan) {
      return res.status(400).json({
        success: false,
        message: 'This request has no active plan to renew yet - use the regular request flow instead.',
      });
    }

    request.status = 'Unpaid';
    request.paymentRequested = false;
    request.paymentRequestedAt = null;
    request.latestPaymentStatus = null;
    request.latestPaymentProof = null;
    request.collectedAmount = 0;
    await request.save();

    res.status(200).json({
      success: true,
      data: {
        requestId: request._id,
        status: request.status,
      },
    });
  } catch (error) {
    next(error);
  }
};

const REQUEST_DETAIL_SELECT =
  'status paymentRequested paymentRequestedAt createdAt startDateForDiet primaryGoal latestPaymentProof subscriptionStartDate subscriptionExpiresAt fullName dateOfBirth gender weight height bmi weightIndex targetWeight activityLevel healthConcerns membershipPlan membershipAmount';

/**
 * Builds the "Order Summary" detail payload for one DietPlanRequest -
 * shared by getRequestStatus (latest) and getRequestById (any specific
 * order from the patient's "Your Orders" list), so both surfaces render
 * identically.
 */
async function buildRequestDetail(request, patientId) {
  let latestProof = null;
  if (request?.latestPaymentProof) {
    latestProof = await ManualPaymentProof.findById(request.latestPaymentProof)
      .select('amountReceived amountPending totalAmount status')
      .lean();
  }

  // Requests created before targetWeight/activityLevel/healthConcerns were
  // added to this schema have those fields empty on the document itself -
  // fall back to the patient's current healthProfile so Order Summary
  // doesn't show a blank BMI card for older requests.
  let targetWeight = request.targetWeight || null;
  let activityLevel = request.activityLevel || null;
  let healthConcerns = request.healthConcerns || [];
  if (!targetWeight || !activityLevel || healthConcerns.length === 0) {
    const patient = await User.findById(patientId).select('healthProfile');
    const healthProfile = patient?.healthProfile || {};
    targetWeight = targetWeight || healthProfile.targetWeight || null;
    activityLevel = activityLevel || healthProfile.activityLevel || null;
    healthConcerns = healthConcerns.length
      ? healthConcerns
      : healthProfile.healthConcerns || [];
  }

  return {
    hasRequest: true,
    requestId: request._id,
    status: request.status,
    // Only an Unpaid request can still be edited/resubmitted (see
    // createDietPlanRequest's upsert-while-Unpaid logic) - surfaced here so
    // both the Home button and the Orders list apply the exact same rule
    // for whether "Update Plan Request" should show.
    isEditable: request.status === 'Unpaid',
    paymentRequested: request.paymentRequested || false,
    paymentRequestedAt: request.paymentRequestedAt || null,
    startDateForDiet: request.startDateForDiet,
    primaryGoal: request.primaryGoal,
    createdAt: request.createdAt,
    paymentSummary: latestProof
      ? {
        amountReceived: latestProof.amountReceived ?? 0,
        amountPending: latestProof.amountPending ?? 0,
        totalAmount: latestProof.totalAmount ?? 0,
        proofStatus: latestProof.status || null,
      }
      : null,
    subscriptionStartDate: request.subscriptionStartDate || null,
    subscriptionExpiresAt: request.subscriptionExpiresAt || null,
    fullName: request.fullName || null,
    dateOfBirth: request.dateOfBirth || null,
    gender: request.gender || null,
    weight: request.weight ?? null,
    height: request.height ?? null,
    bmi: request.bmi ?? null,
    weightIndex: request.weightIndex ?? null,
    targetWeight,
    activityLevel,
    healthConcerns,
    membershipPlan: request.membershipPlan || null,
    membershipAmount: request.membershipAmount ?? null,
  };
}

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
      .select(REQUEST_DETAIL_SELECT);

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
      data: await buildRequestDetail(latestRequest, patientId),
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    List every diet plan request ("order") the logged-in patient has
 *          ever submitted, newest first - one row per renewal cycle - for
 *          the profile screen's "Your Orders" list.
 * @route   GET /api/patient/diet-plan-requests/all
 * @access  Private (Patient)
 */
exports.listRequests = async (req, res, next) => {
  try {
    const requests = await DietPlanRequest.find({ patient: req.user._id })
      .sort({ createdAt: -1 })
      .select('status createdAt startDateForDiet membershipPlan membershipAmount')
      .lean();

    res.status(200).json({
      success: true,
      data: requests.map((r) => ({
        requestId: r._id,
        status: r.status,
        isEditable: r.status === 'Unpaid',
        createdAt: r.createdAt,
        startDateForDiet: r.startDateForDiet,
        membershipPlan: r.membershipPlan || null,
        membershipAmount: r.membershipAmount ?? null,
      })),
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Get one specific diet plan request's full "Order Summary" detail
 *          (any past order, not just the latest) - for the Orders list.
 * @route   GET /api/patient/diet-plan-requests/:id
 * @access  Private (Patient)
 */
exports.getRequestById = async (req, res, next) => {
  try {
    const request = await DietPlanRequest.findOne({
      _id: req.params.id,
      patient: req.user._id,
    }).select(REQUEST_DETAIL_SELECT);

    if (!request) {
      return res.status(404).json({
        success: false,
        message: 'Diet plan request not found',
      });
    }

    res.status(200).json({
      success: true,
      data: await buildRequestDetail(request, req.user._id),
    });
  } catch (error) {
    next(error);
  }
};
