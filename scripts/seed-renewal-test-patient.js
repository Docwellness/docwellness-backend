/**
 * Sets up a self-contained TEST patient for exercising the diet-plan
 * RENEWAL flow end-to-end on prod:
 *
 *   - real Supabase login (can sign into the docwellness-user app)
 *   - height 165, target 65, started at 75kg, now 72kg (Progress history
 *     over 4 weeks so the Goal Journey / weight trend has data)
 *   - a cycle-1 diet plan whose Week 1 anchors ~4 weeks ago, all 4 weeks
 *     finalized, still Active (patient can still log meals)
 *   - subscription with only DAYS_LEFT (3) days left -> the patient app's
 *     "Request diet plan" renewal button is showing, and the patient is in
 *     the last few days of Week 4
 *   - membership Golden, so renewing to Platinum shows the tier-colour
 *     change on the dietician's week cards
 *
 * Also DELETES the old "Etwoe" test patient (and everything under them)
 * first, and any previous run of this same script (idempotent).
 *
 * Connects via connectDB() (config/database.js) - required for prod's
 * self-hosted Mongo TLS. Run from Coolify's Terminal tab for prod.
 *
 * Usage:
 *   node scripts/seed-renewal-test-patient.js                       # dry run
 *   node scripts/seed-renewal-test-patient.js --execute
 *   node scripts/seed-renewal-test-patient.js --execute --email=x@y.com --password=Secret1
 *   node scripts/seed-renewal-test-patient.js --execute --tier=Platinum --days-left=2
 *   node scripts/seed-renewal-test-patient.js --execute --dietician=other@docwellness.fit
 */

require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/database');
// Dual-write days[] alongside the legacy finalizedPlan blob below, same as
// the real finalizeWeekPlan endpoint does - without it, the dietician app's
// Exception Review / Finalize step (which reads days[], not finalizedPlan)
// shows this seeded plan's weeks as blank.
const { daysFromLegacyWeekPayload } = require('../utils/dietPlanLegacyView');

const EXECUTE = process.argv.includes('--execute');
function arg(flag, fallback) {
  const m = process.argv.find((a) => a.startsWith(`--${flag}=`));
  return m ? m.slice(flag.length + 3) : fallback;
}

const PATIENT_EMAIL = arg('email', 'renew-test@docwellness.fit');
const PATIENT_PASSWORD = arg('password', 'RenewTest@2026');
const DIETICIAN_EMAIL = arg('dietician', 'tejasvini@docwellness.fit');
const TIER = arg('tier', 'Golden'); // Silver | Golden | Platinum
const DAYS_LEFT = Number(arg('days-left', '3'));

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const START_WEIGHT = 75;
const CURRENT_WEIGHT = 72;
const HEIGHT_CM = 165;
const TARGET_WEIGHT = '65';

const REQUIRED_SERVING_TIMES = [
  'Morning Drink', 'Breakfast', 'Brunch', 'Lunch', 'Evening Snack', 'Dinner', 'Night Drink',
];
const DAY_GROUPS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday'];

const TIER_AMOUNT = { Silver: 1500, Golden: 2500, Platinum: 5500 };

/** Fully removes a patient + everything under them (incl. Supabase identity). */
async function deletePatientCascade(models, getSupabaseAdmin, patient) {
  const {
    User, DietPlan, DietPlanRequest, ManualPaymentProof, FirstConsultation,
    DayPlan, MealSlotPlan, PlanItem, SupplementItem,
    Progress, MealLog, ExerciseLog, Notification, Goal, Milestone, MilestoneTask,
  } = models;

  const dietPlanIds = (await DietPlan.find({ patientId: patient._id }).select('_id').lean())
    .map((p) => p._id);
  const dayPlanIds = (await DayPlan.find({ dietPlanId: { $in: dietPlanIds } }).select('_id').lean())
    .map((d) => d._id);
  const mealSlotIds = (await MealSlotPlan.find({ dayPlanId: { $in: dayPlanIds } }).select('_id').lean())
    .map((m) => m._id);
  const goalIds = (await Goal.find({ patientId: patient._id }).select('_id').lean())
    .map((g) => g._id);
  const milestoneIds = (await Milestone.find({ goalId: { $in: goalIds } }).select('_id').lean())
    .map((m) => m._id);

  await Promise.all([
    PlanItem.deleteMany({ mealSlotId: { $in: mealSlotIds } }),
    SupplementItem.deleteMany({ mealSlotId: { $in: mealSlotIds } }),
    MilestoneTask.deleteMany({ milestoneId: { $in: milestoneIds } }),
  ]);
  await Promise.all([
    MealSlotPlan.deleteMany({ dayPlanId: { $in: dayPlanIds } }),
    Milestone.deleteMany({ goalId: { $in: goalIds } }),
  ]);
  await Promise.all([
    DayPlan.deleteMany({ dietPlanId: { $in: dietPlanIds } }),
    DietPlan.deleteMany({ patientId: patient._id }),
    DietPlanRequest.deleteMany({ patient: patient._id }),
    ManualPaymentProof.deleteMany({ patient: patient._id }),
    FirstConsultation.deleteMany({ patient: patient._id }),
    Progress.deleteMany({ patientId: patient._id }),
    MealLog.deleteMany({ patientId: patient._id }),
    ExerciseLog.deleteMany({ patientId: patient._id }),
    Goal.deleteMany({ patientId: patient._id }),
    Notification.deleteMany({ userId: patient._id }),
  ]);
  if (patient.supabaseUserId) {
    await getSupabaseAdmin().auth.admin.deleteUser(patient.supabaseUserId).catch((e) => {
      console.log(`  (Supabase delete warning: ${e.message})`);
    });
  }
  await User.deleteOne({ _id: patient._id });
}

async function main() {
  console.log(EXECUTE ? '=== EXECUTING ===' : '=== DRY RUN (pass --execute to write) ===');
  console.log('Connecting to MongoDB...');
  await connectDB();
  console.log('Connected.\n');

  try {
    const models = require('../models');
    const {
      User, Recipe, FirstConsultation, DietPlanRequest, DietPlan,
    } = models;
    const { getSupabaseAdmin } = require('../utils/supabaseAuth');
    const { computeWeekSummary } = require('../utils/weekNutritionSummary');
    const { buildWeekSchedule } = require('../utils/weekSchedule');
    const { logWeight } = require('../utils/weightLog');
    const seedGoalTimeline = require('../utils/seedGoalTimeline').seedGoalTimeline;

    // ---- Dietician ----
    let dietician = await User.findOne({ email: DIETICIAN_EMAIL, role: 'dietician' });
    if (!dietician) dietician = await User.findOne({ role: 'dietician' });
    if (!dietician) throw new Error('No dietician account found.');
    console.log(`Dietician: ${dietician.profile?.fullName || dietician.email} (${dietician._id})`);

    // ---- Clean up: Etwoe + any previous run of this script ----
    const toRemove = await User.find({
      role: 'patient',
      $or: [
        { 'profile.fullName': /etwoe/i },
        { email: /etwoe/i },
        { email: PATIENT_EMAIL },
      ],
    });
    console.log(`\nPatients to remove first: ${toRemove.length ? toRemove.map((u) => `${u.profile?.fullName || u.email}`).join(', ') : '(none)'}`);
    if (EXECUTE) {
      for (const p of toRemove) {
        console.log(`  deleting ${p.email} (${p._id})...`);
        await deletePatientCascade(models, getSupabaseAdmin, p);
      }
    }

    // ---- Recipe pool (one real recipe per serving time) ----
    const recipes = await Recipe.find({ dieticianId: dietician._id })
      .select('name servingTime nutrition servingSize secondaryComponent components category')
      .lean();
    const recipeByServingTime = {};
    for (const r of recipes) {
      if (r.category === 'Supplements') continue;
      if (!recipeByServingTime[r.servingTime]) recipeByServingTime[r.servingTime] = r;
    }
    const missing = REQUIRED_SERVING_TIMES.filter((s) => !recipeByServingTime[s]);
    if (missing.length) {
      throw new Error(`Dietician's recipe pool has no recipe for: ${missing.join(', ')}`);
    }

    // ---- Dates ----
    const now = new Date();
    const week4End = new Date(now.getTime() + DAYS_LEFT * MS_PER_DAY);
    const activation = new Date(week4End.getTime() - 27 * MS_PER_DAY); // buildWeekSchedule: week4.end = anchor + 27d
    const weekSchedule = buildWeekSchedule(activation);
    const subscriptionExpiresAt = week4End;

    console.log(`\nActivation (Week 1 start): ${activation.toDateString()}`);
    console.log(`Week 4: ${weekSchedule[3].startDate.toDateString()} - ${weekSchedule[3].endDate.toDateString()}`);
    console.log(`Subscription expires: ${subscriptionExpiresAt.toDateString()} (${DAYS_LEFT} days left)`);
    console.log(`Membership: ${TIER}`);

    // ---- Week meals + summaries ----
    const buildWeekMeals = () => {
      const dailyMeals = [];
      for (const dayGroup of DAY_GROUPS) {
        for (const servingTime of REQUIRED_SERVING_TIMES) {
          dailyMeals.push({
            dayGroup,
            servingTime,
            recipeId: recipeByServingTime[servingTime]._id,
            servings: 1,
          });
        }
      }
      return dailyMeals;
    };
    const weeksData = [1, 2, 3, 4].map((week) => ({ week, dailyMeals: buildWeekMeals() }));
    const weeksSummary = weeksData.map(({ week, dailyMeals }) => ({
      week,
      fatPercent: 0,
      carbPercent: 0,
      proteinPercent: 0,
      ...computeWeekSummary(dailyMeals, recipes),
    }));
    weeksSummary.forEach((w) => console.log(`  Week ${w.week}: ${w.totalCalories} kcal`));

    if (!EXECUTE) {
      console.log('\nDry run - no writes. Re-run with --execute.');
      return;
    }

    // ---- Supabase identity ----
    const { data: authData, error: authErr } = await getSupabaseAdmin().auth.admin.createUser({
      email: PATIENT_EMAIL,
      password: PATIENT_PASSWORD,
      email_confirm: true,
    });
    if (authErr) throw new Error(`Supabase createUser failed: ${authErr.message}`);
    console.log(`\nSupabase identity: ${authData.user.id}`);

    // ---- Patient ----
    const patient = await User.create({
      email: PATIENT_EMAIL,
      role: 'patient',
      supabaseUserId: authData.user.id,
      profile: {
        fullName: '[TEST] Renewal Rahul',
        gender: 'Male',
        dateOfBirth: new Date('1990-06-20'),
        whatsappNumber: '+910000000001',
      },
      healthProfile: {
        weight: START_WEIGHT,
        height: HEIGHT_CM,
        weightIndex: 2, // Overweight (BMI ~26-27)
        primaryGoal: 'Weight Loss',
        targetWeight: TARGET_WEIGHT,
        activityLevel: 'Lightly Activity',
        healthConcerns: ["I don't have any of these"],
      },
      isVerified: true,
      isActive: true,
    });
    console.log(`Patient: ${patient._id}  <${PATIENT_EMAIL}> / ${PATIENT_PASSWORD}`);

    const consultation = await FirstConsultation.create({
      patient: patient._id,
      dietician: dietician._id,
      dietaryHabitsAllergies: { currentEatingStyle: { options: ['Vegetarian'] } },
    });

    const dietPlanRequest = await DietPlanRequest.create({
      patient: patient._id,
      dieticianId: dietician._id,
      startDateForDiet: activation,
      fullName: patient.profile.fullName,
      membershipPlan: `${TIER} Membership`,
      membershipAmount: TIER_AMOUNT[TIER] || 2500,
      status: 'Paid',
      hasActivePlan: true,
      plansCount: 1,
      subscriptionStartDate: activation,
      subscriptionExpiresAt,
      renewalReminderSentAt: null,
    });

    const dietPlan = await DietPlan.create({
      patientId: patient._id,
      dieticianId: dietician._id,
      status: 'Active',
      isPaid: true,
      activationDate: activation,
      request: dietPlanRequest._id,
      cycleNumber: 1,
      membershipPlan: `${TIER} Membership`,
      weekSchedule,
      firstConsultation: consultation._id,
      calorieStrategy: { name: 'Steady', calorieBudget: 1600 },
      macroStrategy: { name: 'Balanced' },
      generatedPlan: JSON.stringify({ weeks: weeksData }),
      generatedAt: activation,
      finalizedPlan: { weeks: weeksData },
      days: weeksData.flatMap((w) => daysFromLegacyWeekPayload(w)),
      weeksSummary,
    });
    console.log(`DietPlan: ${dietPlan._id} (Active, cycle 1, 4 weeks finalized)`);

    // ---- Weight history 75 -> 72 across the 4 weeks ----
    const weighIns = [
      { d: activation, w: 75.0, src: 'dietician', week: 1 },
      { d: new Date(activation.getTime() + 7 * MS_PER_DAY), w: 74.2, src: 'patient' },
      { d: new Date(activation.getTime() + 14 * MS_PER_DAY), w: 73.3, src: 'patient' },
      { d: new Date(activation.getTime() + 21 * MS_PER_DAY), w: 72.6, src: 'patient' },
      { d: now, w: CURRENT_WEIGHT, src: 'patient' },
    ];
    for (const wi of weighIns) {
      await logWeight(patient._id, wi.w, {
        source: wi.src,
        date: wi.d,
        dieticianId: wi.src === 'dietician' ? dietician._id : null,
        dietPlanId: wi.src === 'dietician' ? dietPlan._id : null,
        week: wi.week || null,
      });
    }
    console.log(`Logged ${weighIns.length} weigh-ins (75 -> ${CURRENT_WEIGHT} kg)`);

    // ---- Goal Journey timeline (same helper activateDietPlan uses) ----
    await seedGoalTimeline(dietPlan).catch((e) => console.log(`  (goal timeline warning: ${e.message})`));

    // ---- Patient status snapshot ----
    await User.findByIdAndUpdate(patient._id, {
      $set: {
        'status.firstConsultationId': consultation._id,
        'status.patientConsented': true,
        'status.activeDietPlanId': dietPlan._id,
        'status.pendingDietPlanId': null,
        'status.requestId': dietPlanRequest._id,
        'status.requestStatus': 'Paid',
        'status.canSendPaymentRequest': false,
        'status.hasPaymentUpdate': false,
        'status.subscriptionExpiresAt': subscriptionExpiresAt,
      },
    });

    console.log('\n=== DONE ===');
    console.log(`Log into the user app as ${PATIENT_EMAIL} / ${PATIENT_PASSWORD}`);
    console.log('Home shows the current Week 4 plan + the "Request diet plan" button.');
    console.log('Tap it -> edit form -> Select Plan -> pick a tier -> the dietician gets "New plan requested".');
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
