const mongoose = require('mongoose');
const { DAY_GROUPS } = require('../utils/dayGroups');
const { REQUIRED_SERVING_TIMES } = require('../utils/servingTimes');

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
    // --- v4.0 ingredient-level portioning + recipe versioning fields ---
    // Which storage model this plan's week/day/meal data actually lives in -
    // decided once at creation time (createAndGenerateDietPlan) and never
    // changed mid-life: 'days-array' (default, the embedded `days[]` below,
    // servingMultiplier-based) or 'plan-item' (DayPlan/MealSlotPlan/PlanItem/
    // RecipeVersion collections, ingredient-level rawQuantity-based). A given
    // patient's plan is 100% one or the other - never a mix - so every
    // days[]-reading function in this codebase keeps working untouched for
    // every plan created before/without the DIET_PLAN_DATA_MODEL flag flipped,
    // and every new plan-item-reading function only ever runs against plans
    // that were actually built that way. See utils/dietPlanReadDispatch.js.
    dataModel: {
      type: String,
      enum: ['days-array', 'plan-item'],
      default: 'days-array',
    },
    // 5-step wizard progress, 'plan-item' plans only - null on every
    // days-array plan (unambiguously "predates the wizard", never confused
    // with a real state). Mirrors the 5 wizard steps 1:1, replacing the old
    // wizard's isFinalized-boolean-only gating with real named states.
    workflowStatus: {
      type: String,
      enum: ['targets_set', 'menu_generated', 'portions_refined', 'timeline_defined', 'finalized'],
      default: null,
    },
    // --- Deterministic diet-plan engine fields (Phase 1c) ---
    // Added alongside finalizedPlan/draftPlan above, not replacing them yet:
    // controllers still read/write the legacy blob directly. `days[]` below
    // becomes the source of truth once scripts/migrate-diet-plan-typed-
    // schema.js has run and utils/dietPlanLegacyView.js's shim is reading
    // from it - see that migration script's header for the cutover sequence.
    // Snapshot of the generation targets used for THIS plan/cycle - distinct
    // from calorieStrategy/macroStrategy above (which stay authoritative for
    // the AI-era fields) so the deterministic engine has one place to read
    // per-slot calorie split, tolerance, and allergy/preference constraints
    // without re-deriving them from FirstConsultation on every run.
    targetProfile: {
      tolerancePercent: { type: Number, default: null },
      // servingTime -> fraction of totalCalories, e.g. {'Breakfast':0.25}.
      mealDistribution: { type: Map, of: Number, default: {} },
      allergies: { type: [String], default: [] },
      preferences: {
        eatingStyle: { type: String, default: null },
        avoid: { type: [String], default: [] },
      },
      createdAt: { type: Date, default: null },
    },
    // servingTime -> portion multiplier, applied by services/weekTweakService.js
    // to every unlocked item in that slot for the currently-open week only.
    weekTweaks: { type: Map, of: Number, default: {} },
    // Set by scripts/migrate-diet-plan-typed-schema.js once this plan's
    // pre-existing finalizedPlan/draftPlan history has been backfilled into
    // days[]/legacyDraftPlanArchive below - the script's idempotency marker,
    // so re-running it after a partial failure skips already-migrated plans
    // (a plan created after the dual-write in finalizeWeekPlan went live
    // never needs backfilling and is marked migrated on first sight).
    daysSchemaMigratedAt: { type: Date, default: null },
    // Audit-only holding place for a draft-only week (present in draftPlan
    // but with no corresponding finalizedPlan entry) found during migration
    // - has no home in the typed days[] schema (which only ever holds real
    // finalized selections, see finalizeWeekPlan's dual-write comment) and
    // is never read by the app. Same {weeks:[{week,dailyMeals}]} shape as
    // draftPlan. Dropped, along with finalizedPlan/draftPlan themselves, in
    // the later cleanup PR once days[] is the confirmed source of truth.
    legacyDraftPlanArchive: { type: Object, default: null },
    // Keyed by {week, dayGroup} - DAY_GROUPS has exactly 4 entries (Monday/
    // Tuesday/Wednesday/Thursday), not 7 real calendar days, matching
    // utils/dayGroups.js's repeat-across-the-week model (Monday's meals also
    // apply Friday, etc.) that the legacy dailyMeals[].dayGroup shape already
    // uses. A day with no matching {week,dayGroup} entry is not yet
    // generated for that week.
    days: [
      {
        week: { type: Number, required: true },
        dayGroup: { type: String, enum: DAY_GROUPS, required: true },
        meals: [
          {
            servingTime: { type: String, enum: REQUIRED_SERVING_TIMES, required: true },
            items: [
              {
                recipeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Recipe', required: true },
                // Same value/semantics as the legacy dailyMeals[].servings
                // field it replaces - the prescribed quantity of this recipe
                // (e.g. 3 chapatis, 8 almonds, 400g of Chole), NOT a bounded
                // scaling ratio - a real prescribed quantity can legitimately
                // fall outside any narrow "reasonable multiplier" range, so
                // this field intentionally has no min/max constraint at the
                // schema level. services/recipeSelectionEngine.js and
                // services/dietPlanAutoBalanceService.js apply their own
                // sane-range clamp (e.g. 0.5-3.0x of a recipe's authored
                // yield) as application logic when THEY compute a value for
                // this field, not as a document-level invariant every writer
                // must satisfy - a dietician manually prescribing 8 almonds
                // must never fail to save.
                servingMultiplier: { type: Number, default: 1, min: 0 },
                // Kept 1:1 with Recipe.components[] for a multi-component
                // recipe (e.g. Idli/Sambar/Chutney), mirroring the legacy
                // componentServings[] shape so per-component quantities
                // survive independent of servingMultiplier.
                componentServings: { type: [Number], default: undefined },
                // Skipped by services/dietPlanAutoBalanceService.js and
                // services/weekTweakService.js - the dietician has manually
                // pinned this item's portion.
                locked: { type: Boolean, default: false },
                isLinkedComponent: { type: Boolean, default: false },
                parentRecipeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Recipe', default: null },
                swapHistory: [
                  {
                    fromRecipeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Recipe' },
                    toRecipeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Recipe' },
                    at: { type: Date, default: Date.now },
                    reason: { type: String, default: null },
                  },
                ],
                // Cached at selection/scale time so reads never re-join
                // Recipe just to show calories/macros.
                calculatedNutrition: {
                  calories: { type: Number, default: null },
                  protein: { type: Number, default: null },
                  carbs: { type: Number, default: null },
                  fats: { type: Number, default: null },
                  fiber: { type: Number, default: null },
                },
                displayText: { type: String, default: null },
              },
            ],
            supplements: [
              {
                // Still a Recipe doc (category:'Supplements') - see
                // dietPlanOptions.js's SUPPLEMENTS_PSEUDO_SLOT.
                supplementId: { type: mongoose.Schema.Types.ObjectId, ref: 'Recipe', required: true },
                dosage: { type: String, default: null },
                instructions: { type: String, default: null },
                timingAnchor: { type: String, enum: ['pre', 'with', 'post'], default: 'with' },
                locked: { type: Boolean, default: true },
                // Supplements already don't count toward nutrition.calories
                // today (they carry supplementFacts instead) - this just
                // makes that existing behavior explicit/queryable.
                excludeFromCalories: { type: Boolean, default: true },
              },
            ],
          },
        ],
      },
    ],
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
// Cross-app performance optimization, Phase 2: the closing-clients dashboard
// tile filters find({ dieticianId, status: 'Active', endDate: { $lte, $gte } }).
// This supersedes the former { dieticianId, status } index (a prefix of this
// one), which still serves getDashboardStats' plain find({ dieticianId, status }).
dietPlanSchema.index({ dieticianId: 1, status: 1, endDate: 1 });
// Covers the renewal-cycle lookup: findOne({patientId, request}).sort({cycleNumber:-1}).
dietPlanSchema.index({ patientId: 1, request: 1, cycleNumber: -1 });

module.exports = mongoose.model('DietPlan', dietPlanSchema);
