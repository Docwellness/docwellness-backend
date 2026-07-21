const mongoose = require('mongoose');
const {
  User,
  DietPlan,
  DietPlanRequest,
  FirstConsultation,
  ManualPaymentProof,
  Progress,
  Chat,
  Conversation,
  Payment,
  Notification,
} = require('../../models');
const CustomFoodRequest = require('../../models/CustomFoodRequest');
const JourneyImage = require('../../models/JourneyImage');
const NeedAttentionLog = require('../../models/NeedAttentionLog');
const WaterLog = require('../../models/WaterLog');
const { getMembershipTier } = require('../../utils/membershipTiers');
const { getSupabaseAdmin } = require('../../utils/supabaseAuth');

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
    if (latestRequest?._id) {
      // A "pay remaining balance" submission creates its own ManualPaymentProof
      // (see submitManualPaymentProof) that only carries that follow-up
      // amount and drops the coupon/subscription context - reading just the
      // latest proof would make an already fully-paid, coupon-discounted
      // subscription look like a bare, coupon-less ₹400 payment. Aggregate
      // across every Approved proof for this request instead: the earliest
      // one (with originalAmount set) is the source of truth for the
      // coupon/subscription total, the latest one is the source of truth
      // for what's still outstanding right now.
      const allProofs = await ManualPaymentProof.find({
        request: latestRequest._id,
      })
        .select(
          'amountReceived amountPending totalAmount status couponCode discountPercentage originalAmount pendingPaymentDate reviewedAt createdAt'
        )
        .sort({ createdAt: 1 })
        .lean();
      const approvedProofs = allProofs.filter((p) => p.status === 'Approved');

      if (approvedProofs.length > 0) {
        const baseProof =
          approvedProofs.find((p) => p.originalAmount != null) || approvedProofs[0];
        const latestProof = approvedProofs[approvedProofs.length - 1];
        const cumulativeReceived = approvedProofs.reduce(
          (sum, p) => sum + (p.amountReceived || 0),
          0
        );
        const currentPending = latestProof.amountPending ?? 0;
        const hadPriorPending =
          approvedProofs.length > 1 &&
          approvedProofs.slice(0, -1).some((p) => (p.amountPending || 0) > 0);

        paymentSummary = {
          amountReceived: cumulativeReceived,
          amountPending: currentPending,
          totalAmount: baseProof.totalAmount ?? cumulativeReceived + currentPending,
          proofStatus: 'Approved',
          couponCode: baseProof.couponCode || null,
          discountPercentage: baseProof.discountPercentage ?? null,
          originalAmount: baseProof.originalAmount ?? null,
          // Once fully paid, the old promise date is resolved - no longer
          // useful to show. balanceClearedAt takes over as "paid on" instead.
          pendingPaymentDate:
            currentPending > 0 ? latestProof.pendingPaymentDate || null : null,
          balanceClearedAt:
            currentPending === 0 && hadPriorPending
              ? latestProof.reviewedAt || null
              : null,
        };
      } else if (allProofs.length > 0) {
        // Nothing approved yet - show the just-submitted proof's own numbers
        // as a preview while the dietician reviews it (unchanged from before).
        const latestProof = allProofs[allProofs.length - 1];
        paymentSummary = {
          amountReceived: latestProof.amountReceived ?? 0,
          amountPending: latestProof.amountPending ?? 0,
          totalAmount: latestProof.totalAmount ?? 0,
          proofStatus: latestProof.status || null,
          couponCode: latestProof.couponCode || null,
          discountPercentage: latestProof.discountPercentage ?? null,
          originalAmount: latestProof.originalAmount ?? null,
          pendingPaymentDate: latestProof.pendingPaymentDate || null,
          balanceClearedAt: null,
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
        .select('_id status weeksSummary generatedPlan calorieStrategy macroStrategy')
        .lean();
    }
    if (!dietPlanForSummary) {
      dietPlanForSummary = await DietPlan.findOne({
        patientId: patient._id,
        status: { $in: ['Finalized', 'Active'] },
      })
        .sort({ createdAt: -1 })
        .select('_id status weeksSummary generatedPlan calorieStrategy macroStrategy')
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
          // Status of the plan activeDietPlanId actually points at right
          // now - lets the frontend tell a genuine first activation
          // ('Finalized', needs Confirm & Activate) apart from a renewal
          // payment where the referenced plan is already 'Active' (needs
          // only a lightweight bill-settle, no plan changes).
          activeDietPlanStatus: dietPlanForSummary?.status || null,
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
        // Lets the dietician app re-open an already-generated/finalized
        // week's Create Diet Plan screen with the Calorie/Macro strategy
        // that was actually used pre-selected, instead of showing a blank
        // form the dietician has to re-fill from scratch every time.
        activePlanStrategy: dietPlanForSummary
          ? {
            calorieStrategy: dietPlanForSummary.calorieStrategy || null,
            macroStrategy: dietPlanForSummary.macroStrategy || null,
          }
          : null,
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

/**
 * @route   DELETE /api/dietician/patients/:patientId
 * @desc    Permanently delete a patient: their User document, every
 *          collection referencing them (diet plans/requests, first
 *          consultation, payments, chat/conversations, meal/water/progress
 *          logs, journey images, custom food requests, need-attention log,
 *          notifications), and their Supabase auth identity.
 *          Irreversible - requires `confirmUsername` in the body to exactly
 *          match the patient's username. The dietician app's UI already
 *          makes the dietician re-type the username before calling this,
 *          but that's a client-side guard only - re-verified here too,
 *          since a destructive/unrecoverable operation should never rely on
 *          client-side confirmation alone.
 * @access  Private (Dietician)
 */
exports.deletePatient = async (req, res, next) => {
  try {
    const { patientId } = req.params;
    const { confirmUsername } = req.body || {};

    if (!mongoose.Types.ObjectId.isValid(patientId)) {
      return res.status(400).json({ success: false, message: 'Invalid patient id' });
    }

    const patient = await User.findById(patientId);
    if (!patient || patient.role !== 'patient') {
      return res.status(404).json({ success: false, message: 'Patient not found' });
    }

    if (typeof confirmUsername !== 'string' || confirmUsername.trim() !== patient.username) {
      return res.status(400).json({
        success: false,
        message: "Typed username does not match this patient's username - deletion cancelled.",
      });
    }

    await Promise.all([
      DietPlan.deleteMany({ patientId }),
      DietPlanRequest.deleteMany({ patient: patientId }),
      FirstConsultation.deleteMany({ patient: patientId }),
      ManualPaymentProof.deleteMany({ patient: patientId }),
      Progress.deleteMany({ patientId }),
      Payment.deleteMany({ patientId }),
      Notification.deleteMany({ userId: patientId }),
      Chat.deleteMany({ $or: [{ senderId: patientId }, { receiverId: patientId }] }),
      Conversation.deleteMany({ 'participants.userId': patientId }),
      CustomFoodRequest.deleteMany({ patientId }),
      JourneyImage.deleteMany({ patientId }),
      NeedAttentionLog.deleteMany({ patientId }),
      WaterLog.deleteMany({ patientId }),
    ]);

    await User.findByIdAndDelete(patientId);

    // Also remove the Supabase identity so no orphaned auth account remains
    // (mirrors the patient's own self-delete flow in
    // controllers/patient/profileController.js's deleteAccount).
    if (patient.supabaseUserId) {
      await getSupabaseAdmin().auth.admin.deleteUser(patient.supabaseUserId).catch((err) => {
        console.error('Failed to delete Supabase user during patient deletion:', err.message);
      });
    }

    res.status(200).json({
      success: true,
      message: 'Patient deleted successfully',
    });
  } catch (error) {
    next(error);
  }
};
