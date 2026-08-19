const mongoose = require('mongoose');

const dietPlanSchema = new mongoose.Schema(
  {
    patientId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    dieticianId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    name: {
      type: String,
      default: 'Diet Plan',
      trim: true,
    },
    description: {
      type: String,
      trim: true,
    },
    startDate: {
      type: Date,
    },
    endDate: {
      type: Date,
    },
    mealsPerDay: {
      type: Number,
      default: 3,
    },
    totalCalories: {
      type: Number,
    },
    status: {
      type: String,
      enum: ['Draft', 'Active', 'Completed', 'Finalized'],
      default: 'Draft',
    },
    activationDate: {
      type: Date,
      default: null,
    },
    isPaid: {
      type: Boolean,
      default: false,
    },
    price: {
      type: Number,
      default: 0,
    },
    paymentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Payment',
    },
    request: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'DietPlanRequest',
    },
    // Which renewal cycle this plan belongs to for this patient+request - 1
    // for the first plan ever built, incremented each time a new DietPlan is
    // created for a patient who already has one (see createAndGenerateDietPlan).
    // Combined with the internal 1-4 week numbering (left untouched) to
    // compute a display-only week number: (cycleNumber-1)*4 + week, so a
    // second cycle shows as Week 5-8 without needing internal week numbers,
    // gating logic, or finalize/generate code to change at all.
    cycleNumber: {
      type: Number,
      default: 1,
    },
    // Per-week date range for this cycle, computed once at creation time
    // (see utils/weekSchedule.js) from this plan's own startDate as the
    // week-1 anchor, 7 days per week. Populated for all 4 weeks up front
    // regardless of tier/generation progress, since a still-locked week
    // (e.g. Platinum's week 2) still needs a displayable date range and a
    // known end-of-week boundary for the finalize+2-day eligibility gate
    // (see utils/membershipTiers.js::validateRegenerateRequest).
    weekSchedule: [
      {
        week: { type: Number, required: true },
        startDate: { type: Date, required: true },
        endDate: { type: Date, required: true },
      },
    ],
    firstConsultation: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'FirstConsultation',
    },
    calorieStrategy: {
      name: { type: String },
      calorieBudget: { type: Number },
      calorieDeficit: { type: Number },
      weeklyWeightLossKg: { type: Number },
      durationWeeks: { type: Number },
    },
    macroStrategy: {
      name: { type: String },
      fatPercent: { type: Number },
      carbsPercent: { type: Number },
      proteinPercent: { type: Number },
      fiberGrams: { type: Number },
    },
    generatedPlan: {
      type: String,
    },
    generatedAt: {
      type: Date,
    },
    // Deterministic post-generation checks (utils/dietPlanValidator.js) - not
    // blocking, surfaced to the dietician during the existing review/finalize
    // flow rather than gating generation itself.
    validationWarnings: {
      type: [String],
      default: [],
    },
    // Special-population safety flags (utils/dieticianPatientHelpers.js +
    // calcAge), e.g. "isMinor", "highProteinForWeight" - make the dietician's
    // mandatory human review well-informed rather than adding a new gate.
    riskFlags: {
      type: [String],
      default: [],
    },
    // Generation lineage for auditability/reproducibility.
    promptVersion: {
      type: String,
      default: null,
    },
    modelSnapshot: {
      type: String,
      default: null,
    },
    inputHash: {
      type: String,
      default: null,
    },
    finalizedPlan: {
      type: Object,
      default: null,
    },
    // AI_EXECUTION_PLAN.md Phase 7, P7-05 (save-draft) - same {weeks:[{week,
    // dailyMeals}]} shape as finalizedPlan above, but written by
    // saveDraftWeek (dietPlanController.js) instead of finalizeWeekPlan, and
    // never passed through computeFinalizeBlockingIssues - a draft is
    // explicitly allowed to be incomplete or invalid, since it hasn't been
    // finalized yet. Independent of finalizedPlan: finalizing a week doesn't
    // clear its draft entry, but getDraftWeekOptions always prefers
    // finalizedPlan over draftPlan for a given week when both exist, so a
    // stale draft can never resurrect over already-finalized, patient-
    // visible selections.
    draftPlan: {
      type: Object,
      default: null,
    },
    weeksSummary: [
      {
        week: { type: Number, required: true },
        totalCalories: { type: Number, default: 0 },
        fatPercent: { type: Number, default: 0 },
        fatGrams: { type: Number, default: 0 },
        carbPercent: { type: Number, default: 0 },
        carbGrams: { type: Number, default: 0 },
        proteinPercent: { type: Number, default: 0 },
        proteinGrams: { type: Number, default: 0 },
        fiberGrams: { type: Number, default: 0 },
      },
    ],
    meals: [
      {
        mealType: {
          type: String,
          enum: ['Breakfast', 'Lunch', 'Dinner', 'Snack'],
          required: true,
        },
        recipes: [
          {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Recipe',
          },
        ],
        totalCalories: { type: Number },
        macros: {
          protein: { type: Number },
          carbs: { type: Number },
          fats: { type: Number },
        },
      },
    ],
  },
  {
    timestamps: true,
  }
);

// Had no indexes at all before this - {patientId, status:'Active'} is by
// far the dominant query shape across both patient- and dietician-side
// controllers (controllers/patient/dietController.js,
// controllers/dietician/dietPlanController.js).
dietPlanSchema.index({ patientId: 1, status: 1 });
dietPlanSchema.index({ dieticianId: 1, status: 1 });
// Covers the renewal-cycle lookup: findOne({patientId, request}).sort({cycleNumber:-1}).
dietPlanSchema.index({ patientId: 1, request: 1, cycleNumber: -1 });

module.exports = mongoose.model('DietPlan', dietPlanSchema);
