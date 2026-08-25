/**
 * Creates a fully realistic TEST patient that simulates an actual new
 * signed-up user end to end - unlike scripts/seed-test-patient-first-
 * consultation.js (which explicitly bypasses Supabase auth and "can never
 * log into the user app"), this one creates a REAL Supabase identity via
 * the same admin API scripts/createDieticianAccount.js already uses, so the
 * resulting patient can actually log into the docwellness-user app with the
 * email/password this script prints.
 *
 * Walks through every real stage a genuine patient goes through:
 *   1. Signup - real Supabase auth user (email_confirm:true, no OTP round
 *      trip needed) + linked Mongo User, same field set
 *      controllers/patient/authController.js's register endpoint writes.
 *   2. First consultation - every real question in
 *      utils/consultationFormSeed.js's DEFAULT_CONSULTATION_FORM_FIELDS
 *      answered (respecting genderScope and dependsOnFieldId/dependsOnValues
 *      gating - a field only appears in customAnswers if its section applies
 *      to the chosen gender and, for a conditional field, its gate's chosen
 *      value actually triggers it), not just the couple of fields the
 *      existing seed script fills.
 *   3. Payment - a real DietPlanRequest walked through the actual
 *      Unpaid -> PaymentRequested -> PaymentSubmitted transitions
 *      controllers/dietician/dietPlanController.js's sendPaymentRequest and
 *      controllers/patient/paymentController.js's submitManualPaymentProof
 *      apply, backed by a real ManualPaymentProof document. Stops at
 *      PaymentSubmitted (proof awaiting the dietician's review) rather than
 *      forcing status:'Paid' - that status is only ever set by
 *      activateDietPlan alongside actually activating a DietPlan
 *      (hasActivePlan:true, subscriptionExpiresAt, etc.), which requires a
 *      finalized DietPlan this script doesn't create; faking 'Paid' without
 *      a plan would be an unreachable, inconsistent combination no real
 *      patient is ever actually in. Pass --approve-payment to additionally
 *      simulate the dietician approving the proof (status:'Paid',
 *      ManualPaymentProof.status:'Approved') if you specifically need that
 *      state instead - hasActivePlan/subscription dates are still left
 *      alone even then, for the same reason.
 *
 * The resulting patient is exactly where a real one would be right before a
 * dietician opens "Create Diet Plan" for them (same handoff point
 * seed-test-patient-first-consultation.js's patients are left at) - but
 * this one can also be used to test the actual patient-facing app/login,
 * payment-proof review screens, and consultation-answer display, which a
 * seed-test-patient-first-consultation.js patient never can.
 *
 * fullName is prefixed "[TEST]" like every other synthetic patient in this
 * codebase, so it's caught by scripts/delete-test-patients.js's cleanup
 * pattern - this is realistic *content*, not a real person, and must stay
 * easy to find and remove later.
 *
 * Usage:
 *   node scripts/seed-realistic-test-patient.js                                   # dry run
 *   node scripts/seed-realistic-test-patient.js --execute
 *   node scripts/seed-realistic-test-patient.js --execute --gender=Male
 *   node scripts/seed-realistic-test-patient.js --execute --approve-payment
 *   node scripts/seed-realistic-test-patient.js --execute --dietician-email=someone@else.com
 *   node scripts/seed-realistic-test-patient.js --execute --delete=<patientId>      # remove this patient (Mongo + real Supabase identity) and everything under them
 *   node scripts/seed-realistic-test-patient.js --execute --delete-email=<email>    # same, looked up by email instead - the id printed on creation is easy to lose in scrollback
 */

require('dotenv').config();
const mongoose = require('mongoose');
// Reuses the app's own connectDB (not a raw mongoose.connect()) - required
// against prod's self-hosted Mongo, which needs a custom TLS CA. See
// createDieticianAccount.js's identical header note.
const connectDB = require('../config/database');
const { DEFAULT_CONSULTATION_FORM_FIELDS } = require('../utils/consultationFormSeed');

const EXECUTE = process.argv.includes('--execute');
const APPROVE_PAYMENT = process.argv.includes('--approve-payment');

function argValue(flag, fallback) {
  const prefix = `--${flag}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

const DIETICIAN_EMAIL = argValue('dietician-email', 'dr.tejasvini.pawar@gmail.com');
const GENDER = argValue('gender', 'Female'); // Female | Male
const DELETE_PATIENT_ID = argValue('delete', null);
const DELETE_EMAIL = argValue('delete-email', null);

function randomPassword() {
  const digits = Math.floor(1000 + Math.random() * 9000);
  return `TestPatient!${digits}`;
}

/**
 * Filters/shapes a flat {fieldId: value} answer map into FirstConsultation.
 * customAnswers[] entries, using DEFAULT_CONSULTATION_FORM_FIELDS as the
 * source of truth for label/type/gating - so this always matches whatever
 * the real form currently asks, rather than a hand-copied field list that
 * can drift out of sync.
 */
function buildCustomAnswers(answers, gender) {
  const genderKey = gender === 'Male' ? 'male' : 'female';
  const entries = [];
  for (const fieldDef of DEFAULT_CONSULTATION_FORM_FIELDS) {
    if (fieldDef.genderScope !== 'general' && fieldDef.genderScope !== genderKey) continue;
    if (!(fieldDef.fieldId in answers)) continue; // not answered (e.g. file upload, or a dependent field we deliberately left out)
    if (fieldDef.dependsOnFieldId) {
      const gateValue = answers[fieldDef.dependsOnFieldId];
      const gateValues = Array.isArray(gateValue) ? gateValue : [gateValue];
      const satisfied = fieldDef.dependsOnValues.some((v) => gateValues.includes(v));
      if (!satisfied) continue; // gate not triggered - a real form would never have shown this field either
    }
    entries.push({ fieldId: fieldDef.fieldId, label: fieldDef.label, type: fieldDef.type, value: answers[fieldDef.fieldId] });
  }
  return entries;
}

/** Every question a real patient could plausibly answer, minus labs_upload (a file) - see header comment on gating. */
function buildAnswers(gender, patientFullName) {
  const common = {
    consent_acknowledgement: ['I consent'],
    consent_signature_name: patientFullName,

    lifestyle_occupation: 'Software Engineer',
    lifestyle_work_hours: '9',
    lifestyle_work_pattern: 'Regular daytime hours',
    lifestyle_who_cooks: 'Self',
    lifestyle_who_you_live_with: 'Spouse',

    goals_primary_goal: 'I want to lose weight sustainably and build healthier eating habits before an upcoming family event.',
    goals_other_concerns: 'Frequent bloating after meals and low energy in the afternoons.',
    goals_readiness: 'Yes',

    anthro_height: gender === 'Male' ? 175 : 160,
    anthro_current_weight: gender === 'Male' ? 82 : 68,
    anthro_highest_weight: gender === 'Male' ? 88 : 74,
    anthro_lowest_weight: gender === 'Male' ? 72 : 55,
    anthro_weight_change: 'Gain',
    anthro_weight_change_amount: '3 kg over the last 6 months',
    anthro_diet_history: "Tried intermittent fasting for 2 months - lost some weight but couldn't sustain it due to hunger.",

    medhx_conditions: ['Thyroid disorder'],
    medhx_surgeries: 'None',

    famhx_conditions: ['Diabetes', 'Hypertension'],

    diet_eating_style: 'Vegetarian',
    diet_vegetarian_subtype: 'Lacto-ovo vegetarian',
    diet_cuisine: 'North Indian',
    diet_allergies_intolerances: ['Dairy / Lactose'],
    diet_foods_to_avoid: 'Avoid beef and pork for religious reasons.',
    diet_cooking_oils: ['Mustard oil', 'Ghee'],
    diet_meals_per_day: 3,
    diet_tea_coffee_cups: 2,
    diet_skip_meals: 'Sometimes',
    diet_skip_meals_which: 'Breakfast, when running late for work',
    diet_snack_frequency: 'Sometimes',
    diet_snack_triggers: ['Stress', 'Boredom'],
    diet_eating_out_frequency: 'Few times a week',
    diet_cravings: ['Sugar', 'Fried foods'],
    diet_water_intake: 2,
    diet_alcohol_smoking: 'No',

    fasting_observed: ['Navratri', 'Ekadashi'],
    fasting_behavior: 'Eat fruits/milk (phalahar)',
    fasting_frequency_duration: 'A few days each month during major festivals',

    digestion_symptoms: ['Gas / Bloating', 'Acidity'],
    digestion_bowel_frequency: 'Daily',

    activity_days_per_week: 3,
    activity_minutes_per_session: 30,
    activity_type: ['Walking', 'Yoga'],
    activity_daytoday_level: 'Mostly sitting',
    activity_sits_more_than_6h: 'Yes',

    sleep_duration: 6,
    sleep_quality_score: 6,
    sleep_quality: 'Interrupted',
    sleep_stress_level: 'Moderate',
    sleep_control_frequency: 'Sometimes',
    sleep_mental_health: 'No',

    eating_behavior_sick_when_full: 'No',
    eating_behavior_lost_control: 'No',
    eating_behavior_weight_loss_6kg: 'No',
    eating_behavior_body_image: 'No',
    eating_behavior_food_dominates: 'No',
    eating_behavior_depressed_frequency: 'Several days',
    eating_behavior_anxious_frequency: 'Several days',

    meds_prescribed: 'No',
    meds_supplements: ['Multivitamins'],

    labs_recent_report_date: '',

    final_notes_concerns: 'Please go easy on dairy in the plan since I get bloated easily.',
    final_preferred_language: 'English',
  };

  const genderSpecific =
    gender === 'Male'
      ? {
          male_symptoms: ['Low energy or fatigue'],
          male_urinary_symptoms: ['None'],
          male_prostate: 'No',
          male_fitness_goals: ['Fat loss', 'General fitness'],
          male_gym_supplements: 'No',
        }
      : {
          female_periods_regular: 'Yes',
          female_conditions: ['None of the above'],
          female_current_treatments: ['None'],
          female_anemia: 'Not sure',
          female_supplements: 'No',
        };

  return { ...common, ...genderSpecific };
}

async function runDelete() {
  const {
    User,
    DietPlanRequest,
    ManualPaymentProof,
    FirstConsultation,
    DietPlan,
    DayPlan,
    MealSlotPlan,
    PlanItem,
    SupplementItem,
  } = require('../models');
  const { getSupabaseAdmin } = require('../utils/supabaseAuth');

  // --delete-email is the more convenient handle right after --execute
  // creates a patient (the printed email is easy to copy; the ObjectId is
  // easy to lose in scrollback) - both resolve to the same lookup below.
  const patient = DELETE_EMAIL ? await User.findOne({ email: DELETE_EMAIL, role: 'patient' }) : await User.findById(DELETE_PATIENT_ID);
  if (!patient) {
    console.log(`No patient found for ${DELETE_EMAIL ? `email ${DELETE_EMAIL}` : `id ${DELETE_PATIENT_ID}`} - nothing to delete.`);
    return;
  }
  console.log(`Found patient: ${patient.profile?.fullName || patient.email} (${patient._id})`);
  console.log(`Supabase identity: ${patient.supabaseUserId || '(none)'}`);

  const dietPlans = await DietPlan.find({ patientId: patient._id }).select('_id');
  const dietPlanIds = dietPlans.map((p) => p._id);
  const dayPlans = await DayPlan.find({ dietPlanId: { $in: dietPlanIds } }).select('_id');
  const dayPlanIds = dayPlans.map((d) => d._id);
  const mealSlots = await MealSlotPlan.find({ dayPlanId: { $in: dayPlanIds } }).select('_id');
  const mealSlotIds = mealSlots.map((m) => m._id);

  console.log('\nWill delete:');
  console.log(`  Supabase auth identity: ${patient.supabaseUserId ? 1 : 0}`);
  console.log(`  User: 1`);
  console.log(`  DietPlanRequest(s)/ManualPaymentProof(s)/FirstConsultation(s) for this patient`);
  console.log(`  DietPlan(s): ${dietPlanIds.length}`);
  console.log(`  DayPlan(s): ${dayPlanIds.length}`);
  console.log(`  MealSlotPlan(s): ${mealSlotIds.length}`);
  console.log(`  PlanItem(s)/SupplementItem(s) under those meal slots`);

  if (!EXECUTE) {
    console.log('\n=== DRY RUN - pass --execute to actually delete ===');
    return;
  }

  await PlanItem.deleteMany({ mealSlotId: { $in: mealSlotIds } });
  await SupplementItem.deleteMany({ mealSlotId: { $in: mealSlotIds } });
  await MealSlotPlan.deleteMany({ dayPlanId: { $in: dayPlanIds } });
  await DayPlan.deleteMany({ dietPlanId: { $in: dietPlanIds } });
  await DietPlan.deleteMany({ patientId: patient._id });
  await ManualPaymentProof.deleteMany({ patient: patient._id });
  await DietPlanRequest.deleteMany({ patient: patient._id });
  await FirstConsultation.deleteMany({ patient: patient._id });
  if (patient.supabaseUserId) {
    await getSupabaseAdmin().auth.admin.deleteUser(patient.supabaseUserId).catch((err) => {
      console.error('  Warning: failed to delete Supabase identity (continuing):', err.message);
    });
  }
  await User.deleteOne({ _id: patient._id });

  console.log('\n=== DELETED ===');
}

async function runCreate() {
  const { User, DietPlanRequest, ManualPaymentProof, FirstConsultation } = require('../models');
  const { getSupabaseAdmin } = require('../utils/supabaseAuth');

  const dietician = await User.findOne({ email: DIETICIAN_EMAIL, role: 'dietician' });
  if (!dietician) {
    throw new Error(`Dietician account not found: ${DIETICIAN_EMAIL}`);
  }
  console.log(`Found dietician: ${dietician.profile?.fullName || dietician.email} (${dietician._id})`);

  const uniqueSuffix = Date.now();
  const baseName = GENDER === 'Male' ? 'Rohan Verma' : 'Ananya Sharma';
  const patientFullName = `[TEST] ${baseName} ${uniqueSuffix}`;
  const patientEmail = `test-patient-real+${uniqueSuffix}@docwellness.fit`;
  const password = randomPassword();
  const whatsappNumber = GENDER === 'Male' ? '9876500001' : '9876500002';
  const dateOfBirth = GENDER === 'Male' ? new Date('1992-08-10') : new Date('1996-03-22');

  const healthProfile = {
    weight: GENDER === 'Male' ? 82 : 68,
    height: GENDER === 'Male' ? 175 : 160,
    primaryGoal: 'Weight Loss',
    targetWeight: GENDER === 'Male' ? '75' : '58',
    activityLevel: 'Lightly Activity',
    healthConcerns: ['Thyroid'],
  };

  console.log('\nWill create:');
  console.log(`  Real Supabase auth user: ${patientEmail} (password printed below on success)`);
  console.log(`  User (patient): ${patientFullName}`);
  console.log(`  DietPlanRequest walked Unpaid -> PaymentRequested -> PaymentSubmitted${APPROVE_PAYMENT ? ' -> Paid (--approve-payment)' : ''}`);
  console.log('  ManualPaymentProof: real document backing the submitted payment');
  console.log('  FirstConsultation: every applicable real question answered (see utils/consultationFormSeed.js)');

  if (!EXECUTE) {
    console.log('\n=== DRY RUN - pass --execute to write ===');
    return;
  }

  const { data: authData, error: authError } = await getSupabaseAdmin().auth.admin.createUser({
    email: patientEmail,
    password,
    email_confirm: true,
  });
  if (authError) {
    throw new Error(`Failed to create Supabase user: ${authError.message}`);
  }

  let patient;
  try {
    patient = await User.create({
      supabaseUserId: authData.user.id,
      email: patientEmail,
      role: 'patient',
      isVerified: true,
      profile: {
        fullName: patientFullName,
        gender: GENDER,
        dateOfBirth,
        whatsappNumber,
      },
      healthProfile,
    });
    console.log(`\nCreated Supabase user: ${authData.user.id}`);
    console.log(`Created Mongo User: ${patient._id}`);

    // Step 1: dietician sends the payment request (mirrors
    // dietPlanController.js's sendPaymentRequest on a fresh Unpaid request).
    const now = new Date();
    const membershipAmount = 4999; // placeholder - no fixed price list exists server-side, client picks the amount at checkout
    let dietPlanRequest = await DietPlanRequest.create({
      patient: patient._id,
      dieticianId: dietician._id,
      startDateForDiet: now,
      primaryGoal: healthProfile.primaryGoal,
      fullName: patient.profile.fullName,
      dateOfBirth: patient.profile.dateOfBirth?.toISOString().slice(0, 10),
      gender: patient.profile.gender,
      weight: healthProfile.weight,
      height: healthProfile.height,
      bmi: patient.healthProfile.bmi,
      weightIndex: patient.healthProfile.weightIndex,
      targetWeight: healthProfile.targetWeight,
      activityLevel: healthProfile.activityLevel,
      healthConcerns: healthProfile.healthConcerns,
      membershipPlan: 'Silver Membership',
      membershipAmount,
      status: 'PaymentRequested',
      paymentRequested: true,
      paymentRequestedAt: now,
    });
    console.log(`Created DietPlanRequest: ${dietPlanRequest._id} (status: PaymentRequested)`);

    // Step 2: patient submits proof (mirrors paymentController.js's
    // submitManualPaymentProof exactly).
    const proof = await ManualPaymentProof.create({
      request: dietPlanRequest._id,
      patient: patient._id,
      amountReceived: membershipAmount,
      amountPending: 0,
      description: 'Paid via UPI - test payment',
    });
    dietPlanRequest.latestPaymentProof = proof._id;
    dietPlanRequest.status = 'PaymentSubmitted';
    dietPlanRequest.latestPaymentStatus = 'Pending';
    await dietPlanRequest.save();
    console.log(`Created ManualPaymentProof: ${proof._id} (status: Submitted)`);
    console.log('DietPlanRequest advanced to: PaymentSubmitted');

    let requestStatus = 'PaymentSubmitted';
    if (APPROVE_PAYMENT) {
      // Optional: dietician approves the proof - mirrors the settlement
      // fields activateDietPlan sets on the request/proof, WITHOUT
      // hasActivePlan/subscription dates (those require an actually
      // finalized+activated DietPlan, which this script doesn't create -
      // see header comment).
      proof.status = 'Approved';
      proof.reviewedBy = dietician._id;
      proof.reviewedAt = new Date();
      await proof.save();
      dietPlanRequest.status = 'Paid';
      dietPlanRequest.latestPaymentStatus = 'Paid';
      dietPlanRequest.collectedAmount = membershipAmount;
      await dietPlanRequest.save();
      requestStatus = 'Paid';
      console.log('--approve-payment: ManualPaymentProof -> Approved, DietPlanRequest -> Paid');
    }

    const firstConsultation = await FirstConsultation.create({
      patient: patient._id,
      dietician: dietician._id,
      dietaryHabitsAllergies: {
        currentEatingStyle: { options: ['Vegetarian'], otherInfo: '' },
        allergiesIntolerances: { options: ['Dairy / Lactose'], otherInfo: '' },
        foodsToAvoid: { text: 'Avoid beef and pork for religious reasons.' },
        cravings: { options: ['Sugar', 'Fried foods'] },
        whoCooksMeals: { options: ['Self'] },
        waterIntake: '2 litres/day',
        alcoholOrSmoking: { uses: 'No', frequency: '' },
      },
      femaleSpecificHealth:
        GENDER === 'Male'
          ? { isApplicable: false, periodsRegular: '', issues: [], onMedications: [] }
          : { isApplicable: true, periodsRegular: 'Yes', issues: [], onMedications: [] },
      digestionElimination: {
        symptoms: ['Gas / Bloating', 'Acidity'],
        bowelFrequency: 'Daily',
      },
      sleepStress: {
        sleepDuration: '6 hours',
        sleepQuality: ['Interrupted'],
        stressLevel: 'Moderate',
        mentalHealthCondition: 'None',
        mentalHealthNotes: '',
      },
      medicationSupplements: {
        onMedication: { answer: 'No', details: '' },
        supplements: { options: ['Multivitamins'], other: '' },
      },
      labReports: { files: [] },
      finalNotes: {
        concerns: 'Please go easy on dairy in the plan since I get bloated easily.',
        readinessToCommit: 'High',
      },
      customAnswers: buildCustomAnswers(buildAnswers(GENDER, patientFullName), GENDER),
    });
    console.log(`Created FirstConsultation: ${firstConsultation._id} (${firstConsultation.customAnswers.length} questions answered)`);

    patient.status = {
      firstConsultationId: firstConsultation._id,
      requestId: dietPlanRequest._id,
      requestStatus,
      patientConsented: true,
      hasPaymentUpdate: !APPROVE_PAYMENT,
      canSendPaymentRequest: false,
    };
    await patient.save();

    console.log('\n=== EXECUTED ===');
    console.log('This patient can log into the docwellness-user app with:');
    console.log(`  Email:    ${patientEmail}`);
    console.log(`  Password: ${password}`);
    console.log('(Supabase never lets you retrieve this password again - save it now if you need it.)');
    console.log('\nAnd is visible in the dietician app, ready for review/"Create Diet Plan":');
    console.log(`  patientId:           ${patient._id}`);
    console.log(`  firstConsultationId: ${firstConsultation._id}`);
    console.log(`  requestId:           ${dietPlanRequest._id}`);
    console.log('\nTo clean this up later, run either:');
    console.log(`  node scripts/seed-realistic-test-patient.js --execute --delete=${patient._id}`);
    console.log(`  node scripts/seed-realistic-test-patient.js --execute --delete-email=${patientEmail}`);
  } catch (err) {
    // Roll back the Supabase identity so a failed run doesn't leave an
    // orphaned account blocking a retry with the same email - same pattern
    // as createDieticianAccount.js.
    await getSupabaseAdmin().auth.admin.deleteUser(authData.user.id).catch(() => {});
    throw err;
  }
}

const DELETE_MODE = !!(DELETE_PATIENT_ID || DELETE_EMAIL);

async function main() {
  console.log(DELETE_MODE ? '=== DELETE MODE ===' : EXECUTE ? '=== EXECUTING realistic test-patient creation ===' : '=== DRY RUN (pass --execute to write) ===');

  console.log('Connecting to MongoDB...');
  const tlsCAFile = connectDB.resolveTlsCAFile();
  const connectOptions = tlsCAFile ? { tls: true, tlsCAFile } : {};
  await mongoose.connect(process.env.MONGODB_URI, connectOptions);
  console.log('Connected.');

  try {
    if (DELETE_MODE) {
      await runDelete();
    } else {
      console.log(`Target dietician: ${DIETICIAN_EMAIL}`);
      console.log(`Gender: ${GENDER}`);
      await runCreate();
    }
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error('Failed:', err);
  process.exit(1);
});
