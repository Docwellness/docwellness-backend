const mongoose = require('mongoose');
const {
  User,
  DietPlan,
  DietPlanRequest,
  FirstConsultation,
  ManualPaymentProof,
} = require('../../models');
const { getMembershipTier } = require('../../utils/membershipTiers');

const formatDate = (value) => {
  if (!value) {
    return null;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const year = date.getFullYear();
  return `${day}-${month}-${year}`;
};

const isProfileComplete = (user) => {
  const profile = user.profile || {};
  const healthProfile = user.healthProfile || {};
  return Boolean(
    user.isVerified &&
    profile.fullName &&
    typeof healthProfile.weight === 'number' &&
    healthProfile.weight > 0
  );
};

/**
 * Payment state UI summary for Flutter:
 * - Show "Send payment request" when status.requestStatus === 'Unpaid' && status.canSendPaymentRequest === true.
 * - Show "Payment Update Received" + Activate CTA when status.requestStatus === 'PaymentSubmitted' && status.hasPaymentUpdate === true.
 * - Consider the diet visible to the patient when status.requestStatus === 'Paid' && status.activeDietPlanId is not null.
 *
 * @desc    Fetch patient summary for dieticians
 * @route   GET /api/dietician/patients/:patientId/profile
 * @access  Private (Dietician)
 */
exports.getPatientProfile = async (req, res, next) => {
  try {
    const { patientId } = req.params;

    const patient = await User.findById(patientId)
      .select(
        'role username email profile.fullName profile.gender profile.dateOfBirth profile.whatsappNumber profile.profileImage healthProfile.height healthProfile.weight healthProfile.bmi healthProfile.weightIndex healthProfile.primaryGoal healthProfile.targetWeight healthProfile.healthConcerns healthProfile.activityLevel isVerified isActive status'
      )
      .lean();

    if (!patient || patient.role !== 'patient') {
      return res.status(404).json({
        success: false,
        message: 'Patient not found',
      });
    }

    const [firstConsultation, latestRequest] = await Promise.all([
      FirstConsultation.findOne({ patient: patient._id })
        .sort({ createdAt: 1 })
        .select('_id')
        .lean(),
      DietPlanRequest.findOne({ patient: patient._id })
        .sort({ createdAt: -1 })
        .select('_id status latestPaymentProof startDateForDiet membershipPlan')
        .lean(),
    ]);

    let paymentSummary = null;
    if (latestRequest?.latestPaymentProof) {
      const latestProof = await ManualPaymentProof.findById(
        latestRequest.latestPaymentProof
      )
        .select('amountReceived amountPending totalAmount status')
        .lean();

      if (latestProof) {
        paymentSummary = {
          amountReceived: latestProof.amountReceived ?? 0,
          amountPending: latestProof.amountPending ?? 0,
          totalAmount: latestProof.totalAmount ?? 0,
          proofStatus: latestProof.status || null,
        };
      }
    }

    const rawTargetWeight = patient.healthProfile?.targetWeight;

    const statusSnapshot = patient.status || {};

    // Prefer the patient's tracked activeDietPlanId - set as soon as any
    // generation happens, even while the plan is still Draft - so weekly
    // card state (which weeks are generated vs. finalized) is visible
    // before the plan reaches Finalized/Active. Falls back to the newest
    // Finalized/Active plan for older records predating this being set
    // unconditionally.
    let dietPlanForSummary = null;
    if (statusSnapshot.activeDietPlanId && mongoose.Types.ObjectId.isValid(statusSnapshot.activeDietPlanId)) {
      dietPlanForSummary = await DietPlan.findById(statusSnapshot.activeDietPlanId)
        .select('_id status weeksSummary generatedPlan')
        .lean();
    }
    if (!dietPlanForSummary) {
      dietPlanForSummary = await DietPlan.findOne({
        patientId: patient._id,
        status: { $in: ['Finalized', 'Active'] },
      })
        .sort({ createdAt: -1 })
        .select('_id status weeksSummary generatedPlan')
        .lean();
    }

    const weeklyDietPlans = Array.isArray(dietPlanForSummary?.weeksSummary)
      ? dietPlanForSummary.weeksSummary.map((weekEntry) => ({
        week: weekEntry.week,
        totalCalories: weekEntry.totalCalories,
      }))
      : [];

    // Which weeks have AI-generated content ready for meal selection, even
    // before finalization (weeklyDietPlans/weeksSummary only reflects
    // finalized weeks) - lets the frontend distinguish "generated, tap to
    // pick meals" from "not yet generated" for the tier-gated regeneration UI.
    let generatedWeekNumbers = [];
    if (dietPlanForSummary?.generatedPlan) {
      try {
        const parsedGeneratedPlan = JSON.parse(dietPlanForSummary.generatedPlan);
        generatedWeekNumbers = Array.isArray(parsedGeneratedPlan?.weeks)
          ? parsedGeneratedPlan.weeks.map((w) => w.week)
          : [];
      } catch (_) {
        generatedWeekNumbers = [];
      }
    }

    const activeDietPlanId = statusSnapshot.activeDietPlanId || dietPlanForSummary?._id || null;

    res.status(200).json({
      success: true,
      data: {
        id: patient._id,
        basic: {
          fullName: patient.profile?.fullName || null,
          username: patient.username,
          email: patient.email,
          whatsappNumber: patient.profile?.whatsappNumber || null,
          gender: patient.profile?.gender || null,
          dateOfBirth: formatDate(patient.profile?.dateOfBirth),
          profileImage: patient.profile?.profileImage || null,
        },
        healthSummary: {
          startDateForDiet: formatDate(latestRequest?.startDateForDiet),
          height: patient.healthProfile?.height ?? null,
          weight: patient.healthProfile?.weight ?? null,
          bmi: patient.healthProfile?.bmi ?? null,
          weightIndex: patient.healthProfile?.weightIndex ?? null,
          primaryGoal: patient.healthProfile?.primaryGoal || null,
          targetWeight: rawTargetWeight == null ? null : String(rawTargetWeight),
          activityLevel: patient.healthProfile?.activityLevel || null,
          healthConcerns: patient.healthProfile?.healthConcerns || [],
        },
        status: {
          isProfileComplete: isProfileComplete(patient),
          requestId: statusSnapshot.requestId || latestRequest?._id || null,
          requestStatus: statusSnapshot.requestStatus || latestRequest?.status || null,
          firstConsultationId: statusSnapshot.firstConsultationId || firstConsultation?._id || null,
          patientConsented: statusSnapshot.patientConsented === true,
          activeDietPlanId, // Updated to use the fallback logic
          membershipPlan: latestRequest?.membershipPlan || null,
          // Normalized 'silver'|'golden'|'platinum'|null so the frontend
          // branches on a clean enum instead of re-parsing the raw string.
          membershipTier: getMembershipTier(latestRequest?.membershipPlan),
          canSendPaymentRequest:
            typeof statusSnapshot.canSendPaymentRequest === 'boolean'
              ? statusSnapshot.canSendPaymentRequest
              : false,
          hasPaymentUpdate:
            typeof statusSnapshot.hasPaymentUpdate === 'boolean'
              ? statusSnapshot.hasPaymentUpdate
              : false,
          isActive: patient.isActive !== false,
          paymentSummary,
        },
        weeklyDietPlans,
        generatedWeekNumbers,
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @route   PUT /api/dietician/patients/:patientId/deactivate
 * @desc    Toggle patient active status (deactivate/activate)
 */
exports.togglePatientActive = async (req, res, next) => {
  try {
    const { patientId } = req.params;
    const { isActive } = req.body;

    const patient = await User.findById(patientId);
    if (!patient || patient.role !== 'patient') {
      return res.status(404).json({ success: false, message: 'Patient not found' });
    }

    patient.isActive = typeof isActive === 'boolean' ? isActive : !patient.isActive;
    await patient.save();

    res.status(200).json({
      success: true,
      data: { isActive: patient.isActive },
    });
  } catch (error) {
    next(error);
  }
};
