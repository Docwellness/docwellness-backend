/**
 * Creates (or deletes) a synthetic TEST patient, all the way through "first
 * consultation complete" - the exact point where a real dietician can open
 * the Create Diet Plan wizard and generate a plan for them. Exists purely
 * to let a human manually test the v4.0 wizard flow (Targets -> Generate ->
 * Refine Portions -> Timeline -> Finalize) against a real dietician account
 * without needing a real patient to sign up and fill out a real
 * consultation first.
 *
 * Bypasses the app's HTTP/Supabase-auth signup flow entirely - this patient
 * has NO Supabase account and can never log into the user app. It exists
 * only as backend data for the DIETICIAN side to see and act on.
 *
 * Default membership is Silver, deliberately - Silver generates all 4
 * weeks in the single initial "Create Diet Plan" action and never offers
 * regeneration at all (see utils/membershipTiers.js's TIER_INITIAL_WEEKS/
 * validateRegenerateRequest), so nothing about later weeks is gated behind
 * finalizing the current one first - every week is immediately available
 * to poke at. Override with --membership if you specifically want to test
 * Golden/Platinum's regeneration cadence instead.
 *
 * FirstConsultation is filled in on every section a real submission would
 * have - NOT just `{patient, dietician}` (which is schema-minimal but
 * looks obviously fake, and doesn't matter for realism since diet-plan
 * generation doesn't even read those structured fields - see next
 * paragraph). Option strings are the REAL ones the consultation form UI
 * offers (utils/consultationFormSeed.js), not invented values.
 *
 * IMPORTANT: controllers/dietician/dietPlanController.js's actual diet-plan
 * generation logic reads eating-style/allergies from `customAnswers[]` by
 * fieldId (utils/dietaryConstraintValidator.js's getConsultationAnswer),
 * NOT from the structured dietaryHabitsAllergies object above it - both are
 * populated here, but customAnswers is what actually drives recipe
 * filtering, so it's the one that matters for the generated plan to look
 * realistic (right pool of recipes, right allergen exclusions).
 *
 * Usage:
 *   node scripts/seed-test-patient-first-consultation.js                          # dry run, create
 *   node scripts/seed-test-patient-first-consultation.js --execute                # actually create
 *   node scripts/seed-test-patient-first-consultation.js --execute --dietician-email=someone@else.com
 *   node scripts/seed-test-patient-first-consultation.js --execute --membership=Golden
 *   node scripts/seed-test-patient-first-consultation.js --execute --delete=<patientId>   # remove a previously-created test patient and everything under them
 */

require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/database');

const EXECUTE = process.argv.includes('--execute');

function argValue(flag, fallback) {
  const prefix = `--${flag}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

const DIETICIAN_EMAIL = argValue('dietician-email', 'dr.tejasvini.pawar@gmail.com');
const MEMBERSHIP_TIER = argValue('membership', 'Silver'); // Silver | Golden | Platinum
const DELETE_PATIENT_ID = argValue('delete', null);

async function runDelete() {
  const { User, DietPlanRequest, FirstConsultation, DietPlan, DayPlan, MealSlotPlan, PlanItem, SupplementItem } = require('../models');

  const patient = await User.findById(DELETE_PATIENT_ID);
  if (!patient) {
    console.log(`No User found for id ${DELETE_PATIENT_ID} - nothing to delete.`);
    return;
  }
  console.log(`Found patient: ${patient.profile?.fullName || patient.email} (${patient._id})`);

  const dietPlans = await DietPlan.find({ patientId: patient._id }).select('_id');
  const dietPlanIds = dietPlans.map((p) => p._id);
  const dayPlans = await DayPlan.find({ dietPlanId: { $in: dietPlanIds } }).select('_id');
  const dayPlanIds = dayPlans.map((d) => d._id);
  const mealSlots = await MealSlotPlan.find({ dayPlanId: { $in: dayPlanIds } }).select('_id');
  const mealSlotIds = mealSlots.map((m) => m._id);

  console.log('\nWill delete:');
  console.log(`  User: 1`);
  console.log(`  DietPlanRequest(s) for this patient`);
  console.log(`  FirstConsultation(s) for this patient`);
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
  await DietPlanRequest.deleteMany({ patient: patient._id });
  await FirstConsultation.deleteMany({ patient: patient._id });
  await User.deleteOne({ _id: patient._id });

  console.log('\n=== DELETED ===');
}

async function runCreate() {
  const { User, DietPlanRequest, FirstConsultation } = require('../models');

  const dietician = await User.findOne({ email: DIETICIAN_EMAIL, role: 'dietician' });
  if (!dietician) {
    throw new Error(`Dietician account not found: ${DIETICIAN_EMAIL}`);
  }
  console.log(`Found dietician: ${dietician.profile?.fullName || dietician.email} (${dietician._id})`);

  const uniqueSuffix = Date.now();
  const patientEmail = `test-patient-qa+${uniqueSuffix}@docwellness.fit`;
  const patientFullName = `[TEST] v4.0 QA Patient ${uniqueSuffix}`;

  console.log('\nWill create:');
  console.log(`  User (patient): ${patientFullName} <${patientEmail}>`);
  console.log(`  DietPlanRequest: membershipPlan="${MEMBERSHIP_TIER} Membership", dieticianId=${dietician._id}`);
  console.log('  FirstConsultation: every section filled, including the customAnswers diet-generation actually reads');

  if (!EXECUTE) {
    console.log('\n=== DRY RUN - pass --execute to write ===');
    return;
  }

  const patient = await User.create({
    email: patientEmail,
    role: 'patient',
    isVerified: true,
    profile: {
      fullName: patientFullName,
      gender: 'Female',
      dateOfBirth: new Date('1994-06-15'),
      whatsappNumber: '9999999999',
    },
    healthProfile: {
      // weight/height drive bmi/weightIndex via the pre('validate') hook -
      // not set explicitly, so they can never drift out of sync with these.
      weight: 72,
      height: 165,
      primaryGoal: 'Weight Loss',
      targetWeight: '62',
      activityLevel: 'Moderately Activity',
      healthConcerns: ["I don't have any of these"],
    },
  });
  console.log(`\nCreated User: ${patient._id}`);

  const dietPlanRequest = await DietPlanRequest.create({
    patient: patient._id,
    dieticianId: dietician._id,
    startDateForDiet: new Date(),
    status: 'Paid',
    membershipPlan: `${MEMBERSHIP_TIER} Membership`,
    fullName: patient.profile.fullName,
  });
  console.log(`Created DietPlanRequest: ${dietPlanRequest._id}`);

  const firstConsultation = await FirstConsultation.create({
    patient: patient._id,
    dietician: dietician._id,
    dietaryHabitsAllergies: {
      currentEatingStyle: { options: ['Vegetarian'], otherInfo: '' },
      allergiesIntolerances: { options: ['Nuts'], otherInfo: '' },
      foodsToAvoid: { text: 'Mushrooms, bitter gourd' },
      cravings: { options: ['Sugar', 'Fried foods'] },
      whoCooksMeals: { options: ['Self'] },
      waterIntake: '2-3 litres/day',
      alcoholOrSmoking: { uses: 'No', frequency: '' },
    },
    femaleSpecificHealth: {
      isApplicable: true,
      periodsRegular: 'Yes',
      issues: [],
      onMedications: [],
    },
    digestionElimination: {
      symptoms: ['Gas / Bloating'],
      bowelFrequency: 'Once daily',
    },
    sleepStress: {
      sleepDuration: '6-7 hours',
      sleepQuality: ['Restful'],
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
      concerns: 'Wants to lose weight sustainably before an upcoming event.',
      readinessToCommit: 'High',
    },
    // The fields diet-plan generation ACTUALLY reads (see this file's
    // header comment) - fieldIds match SAFETY_FIELD_IDS in
    // utils/dietaryConstraintValidator.js exactly.
    customAnswers: [
      { fieldId: 'diet_eating_style', label: 'What is your current eating style?', type: 'singleChoice', value: 'Vegetarian' },
      { fieldId: 'diet_allergies_intolerances', label: 'Do you have any allergies or intolerances?', type: 'multiChoice', value: ['Nuts'] },
    ],
  });
  console.log(`Created FirstConsultation: ${firstConsultation._id}`);

  patient.status = {
    firstConsultationId: firstConsultation._id,
    requestId: dietPlanRequest._id,
    requestStatus: dietPlanRequest.status,
    patientConsented: true,
  };
  await patient.save();

  console.log('\n=== EXECUTED ===');
  console.log('This patient is now visible in the dietician app\'s patient list and ready for');
  console.log('"Create Diet Plan" - all the ids you need:');
  console.log(`  patientId:           ${patient._id}`);
  console.log(`  firstConsultationId: ${firstConsultation._id}`);
  console.log(`  requestId:           ${dietPlanRequest._id}`);
  console.log('\nTo clean this up later, run:');
  console.log(`  node scripts/seed-test-patient-first-consultation.js --execute --delete=${patient._id}`);
}

async function main() {
  console.log(DELETE_PATIENT_ID ? '=== DELETE MODE ===' : EXECUTE ? '=== EXECUTING test-patient creation ===' : '=== DRY RUN (pass --execute to write) ===');

  console.log('Connecting to MongoDB...');
  const tlsCAFile = connectDB.resolveTlsCAFile();
  const connectOptions = tlsCAFile ? { tls: true, tlsCAFile } : {};
  await mongoose.connect(process.env.MONGODB_URI, connectOptions);
  console.log('Connected.');

  try {
    if (DELETE_PATIENT_ID) {
      await runDelete();
    } else {
      console.log(`Target dietician: ${DIETICIAN_EMAIL}`);
      console.log(`Membership tier: ${MEMBERSHIP_TIER}`);
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
