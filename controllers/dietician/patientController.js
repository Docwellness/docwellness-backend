const mongoose = require('mongoose');
const {
  User,
  DietPlan,
  DayPlan,
  DietPlanRequest,
  FirstConsultation,
  ManualPaymentProof,
  Progress,
  Chat,
  Conversation,
  MealLog,
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

/**
 * Whether `dieticianId` has ever had a diet-plan-request relationship with
 * `patientId` - the same relationship listPatientsForDietician (see
 * dietPlanController.js) scopes its "new"/"ongoing"/"past" tabs by, so a
 * patient visible in any tab is always accessible here too. Without this,
 * any authenticated dietician-role account could view/deactivate/delete any
 * patient in the system, not just their own.
 */
const assertDieticianOwnsPatient = (dieticianId, patientId) =>
  DietPlanRequest.exists({ patient: patientId, dieticianId });

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
        'role email profile.fullName profile.gender profile.dateOfBirth profile.whatsappNumber profile.profileImage healthProfile.height healthProfile.weight healthProfile.bmi healthProfile.weightIndex healthProfile.primaryGoal healthProfile.targetWeight healthProfile.healthConcerns healthProfile.activityLevel isVerified isActive status'
      )
      .lean();

    if (!patient || patient.role !== 'patient') {
      return res.status(404).json({
        success: false,
        message: 'Patient not found',
      });
    }

    if (!(await assertDieticianOwnsPatient(req.user._id, patient._id))) {
      return res.status(403).json({
        success: false,
        message: 'You are not authorized to access this patient',
      });
    }

    const [firstConsultation, latestRequest] = await Promise.all([
      FirstConsultation.findOne({ patient: patient._id })
        .sort({ createdAt: 1 })
        .select('_id')
        .lean(),
      DietPlanRequest.findOne({ patient: patient._id })
        .sort({ createdAt: -1 })
        .select('_id status latestPaymentProof startDateForDiet membershipPlan hasActivePlan')
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

    const DIET_PLAN_SUMMARY_SELECT =
      '_id status workflowStatus dataModel weeksSummary generatedPlan calorieStrategy macroStrategy cycleNumber weekSchedule membershipPlan';

    // weeklyDietPlans (finalized weeks + their calories) and
    // generatedWeekNumbers (weeks with AI content ready, pre-finalize) for
    // one plan - the same derivation for the active cycle and, during a
    // renewal, the pending next cycle. weeklyDietPlans/weeksSummary only
    // reflects finalized weeks; generatedWeekNumbers lets the frontend tell
    // "generated, tap to pick meals" from "not yet generated". A v4.0
    // plan-item plan stores nothing in generatedPlan/weeksSummary - its
    // weeks live as DayPlan documents - so both signals are derived from
    // those instead (finalizes as a whole, not week by week).
    const deriveWeeksForPlan = async (planDoc) => {
      let weeklyDietPlans = Array.isArray(planDoc?.weeksSummary)
        ? planDoc.weeksSummary.map((weekEntry) => ({
          week: weekEntry.week,
          totalCalories: weekEntry.totalCalories,
        }))
        : [];

      let generatedWeekNumbers = [];
      if (planDoc?.generatedPlan) {
        try {
          const parsed = JSON.parse(planDoc.generatedPlan);
          generatedWeekNumbers = Array.isArray(parsed?.weeks)
            ? parsed.weeks.map((w) => w.week)
            : [];
        } catch (_) {
          generatedWeekNumbers = [];
        }
      }

      if (planDoc?._id && planDoc.dataModel === 'plan-item') {
        const planItemWeeks = (await DayPlan.distinct('week', { dietPlanId: planDoc._id }))
          .filter((w) => Number.isInteger(w) && w >= 1 && w <= 4)
          .sort((a, b) => a - b);
        generatedWeekNumbers = planItemWeeks;
        if (['Finalized', 'Active', 'Completed'].includes(planDoc.status)) {
          const perWeekCalories = planDoc.calorieStrategy?.calorieBudget || 0;
          weeklyDietPlans = planItemWeeks.map((week) => ({ week, totalCalories: perWeekCalories }));
        }
      }

      const finalizedWeekNumbers = weeklyDietPlans
        .filter((w) => (w.totalCalories || 0) > 0)
        .map((w) => w.week);

      return { weeklyDietPlans, generatedWeekNumbers, finalizedWeekNumbers };
    };

    // Prefer the patient's tracked activeDietPlanId - set as soon as any
    // generation happens, even while the plan is still Draft - so weekly
    // card state (which weeks are generated vs. finalized) is visible
    // before the plan reaches Finalized/Active. During a renewal this stays
    // pointed at the *live* cycle (the new build is status.pendingDietPlanId,
    // handled separately below). Falls back to the newest Finalized/Active
    // plan for older records predating this being set unconditionally.
    let dietPlanForSummary = null;
    if (statusSnapshot.activeDietPlanId && mongoose.Types.ObjectId.isValid(statusSnapshot.activeDietPlanId)) {
      dietPlanForSummary = await DietPlan.findById(statusSnapshot.activeDietPlanId)
        .select(DIET_PLAN_SUMMARY_SELECT)
        .lean();
    }
    if (!dietPlanForSummary) {
      dietPlanForSummary = await DietPlan.findOne({
        patientId: patient._id,
        status: { $in: ['Finalized', 'Active'] },
      })
        .sort({ createdAt: -1 })
        .select(DIET_PLAN_SUMMARY_SELECT)
        .lean();
    }

    const activeWeeks = await deriveWeeksForPlan(dietPlanForSummary);
    const weeklyDietPlans = activeWeeks.weeklyDietPlans;
    const generatedWeekNumbers = activeWeeks.generatedWeekNumbers;

    // A renewal has been requested (the patient re-ran the request flow -
    // startRenewal flips the shared request back to unpaid while its
    // hasActivePlan stays true) but the new cycle isn't paid/activated yet.
    // True from the moment of the request, before the dietician has built
    // anything - the entry point to build the next cycle keys off this.
    const renewalPending =
      latestRequest?.hasActivePlan === true &&
      !['Paid', 'PartiallyPaid'].includes(latestRequest?.status);

    // Once the dietician has started building it, the next cycle's plan is
    // surfaced as its own block (its own week-state signals) so the app can
    // show "Week 5-8" cards + a Resume button without disturbing the
    // running cycle's UI. Null until the first generation for the renewal.
    let pendingCycle = null;
    if (
      renewalPending &&
      statusSnapshot.pendingDietPlanId &&
      mongoose.Types.ObjectId.isValid(statusSnapshot.pendingDietPlanId)
    ) {
      const pendingPlan = await DietPlan.findById(statusSnapshot.pendingDietPlanId)
        .select(DIET_PLAN_SUMMARY_SELECT)
        .lean();
      if (pendingPlan && pendingPlan._id?.toString() !== dietPlanForSummary?._id?.toString()) {
        const pendingWeeks = await deriveWeeksForPlan(pendingPlan);
        pendingCycle = {
          dietPlanId: pendingPlan._id,
          status: pendingPlan.status || null,
          workflowStatus: pendingPlan.workflowStatus || null,
          dataModel: pendingPlan.dataModel || null,
          cycleNumber: pendingPlan.cycleNumber || 1,
          weekSchedule: pendingPlan.weekSchedule || [],
          generatedWeekNumbers: pendingWeeks.generatedWeekNumbers,
          finalizedWeekNumbers: pendingWeeks.finalizedWeekNumbers,
          activePlanStrategy: {
            calorieStrategy: pendingPlan.calorieStrategy || null,
            macroStrategy: pendingPlan.macroStrategy || null,
          },
        };
      }
    }

    // Membership badge / avatar ring on the dietician's patient profile
    // must reflect the tier the *currently active* cycle was sold as, not
    // whatever the patient just picked for a pending renewal
    // (DietPlanRequest.membershipPlan is overwritten in place on renewal).
    // Prefer the active plan's own snapshot; fall back to the request for
    // plans created before DietPlan.membershipPlan existed.
    const activeMembershipPlan =
      dietPlanForSummary?.membershipPlan || latestRequest?.membershipPlan || null;
    const pendingMembershipPlan = renewalPending ? latestRequest?.membershipPlan || null : null;

    const activeDietPlanId = statusSnapshot.activeDietPlanId || dietPlanForSummary?._id || null;

    res.status(200).json({
      success: true,
      data: {
        id: patient._id,
        basic: {
          fullName: patient.profile?.fullName || null,
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
          // now - 'Finalized' means it needs Confirm & Activate,
          // 'Active' means it's already live.
          activeDietPlanStatus: dietPlanForSummary?.status || null,
          // How far the build wizard got on a still-Draft plan
          // (targets_set -> menu_generated -> portions_refined ->
          // finalized) plus its data model - lets the dietician app resume
          // the wizard at the right step instead of restarting from Targets.
          activeDietPlanWorkflowStatus: dietPlanForSummary?.workflowStatus || null,
          activeDietPlanDataModel: dietPlanForSummary?.dataModel || null,
          // Which renewal cycle dietPlanForSummary belongs to (1 = first
          // plan ever built for this patient, incremented per renewal) -
          // combines with weeklyDietPlans/generatedWeekNumbers' internal
          // 1-4 week numbers as (cycleNumber-1)*4 + week to display "Week
          // 5" etc. for a second cycle onward.
          cycleNumber: dietPlanForSummary?.cycleNumber || 1,
          // The tier the currently-active cycle was sold as (snapshot on
          // the plan, request fallback for legacy plans) - NOT the pending
          // renewal's pick. Drives the profile badge + avatar ring.
          membershipPlan: activeMembershipPlan,
          // Normalized 'silver'|'golden'|'platinum'|null so the frontend
          // branches on a clean enum instead of re-parsing the raw string.
          membershipTier: getMembershipTier(activeMembershipPlan),
          // A renewal is being built for this patient - the current cycle
          // is still live; badge/ring/weekly-plan swap wait for activation.
          renewalPending,
          pendingMembershipPlan,
          pendingMembershipTier: getMembershipTier(pendingMembershipPlan),
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
        // Per-week date ranges for dietPlanForSummary's cycle (see
        // utils/weekSchedule.js) - populated for all 4 internal weeks
        // regardless of generation/finalize progress, since even a locked
        // week needs a displayable date and the finalize-time gate
        // (validateRegenerateRequest) needs a known end-of-week boundary.
        weekSchedule: dietPlanForSummary?.weekSchedule || [],
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
        // The next cycle being built during a renewal (null otherwise).
        // Same week-state signals as the active cycle above, for the
        // "Week 5-8" cards + Create/Resume button under Weekly Diet Plans.
        pendingCycle,
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

    if (!(await assertDieticianOwnsPatient(req.user._id, patient._id))) {
      return res.status(403).json({
        success: false,
        message: 'You are not authorized to access this patient',
      });
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
 *          Irreversible - requires `confirmEmail` in the body to exactly
 *          match the patient's email. The dietician app's UI already
 *          makes the dietician re-type the email before calling this,
 *          but that's a client-side guard only - re-verified here too,
 *          since a destructive/unrecoverable operation should never rely on
 *          client-side confirmation alone.
 * @access  Private (Dietician)
 */
exports.deletePatient = async (req, res, next) => {
  try {
    const { patientId } = req.params;
    const { confirmEmail } = req.body || {};

    if (!mongoose.Types.ObjectId.isValid(patientId)) {
      return res.status(400).json({ success: false, message: 'Invalid patient id' });
    }

    const patient = await User.findById(patientId);
    if (!patient || patient.role !== 'patient') {
      return res.status(404).json({ success: false, message: 'Patient not found' });
    }

    if (!(await assertDieticianOwnsPatient(req.user._id, patient._id))) {
      return res.status(403).json({
        success: false,
        message: 'You are not authorized to access this patient',
      });
    }

    if (typeof confirmEmail !== 'string' || confirmEmail.trim().toLowerCase() !== patient.email) {
      return res.status(400).json({
        success: false,
        message: "Typed email does not match this patient's email - deletion cancelled.",
      });
    }

    await Promise.all([
      DietPlan.deleteMany({ patientId }),
      DietPlanRequest.deleteMany({ patient: patientId }),
      FirstConsultation.deleteMany({ patient: patientId }),
      ManualPaymentProof.deleteMany({ patient: patientId }),
      Progress.deleteMany({ patientId }),
      MealLog.deleteMany({ patientId }),
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
