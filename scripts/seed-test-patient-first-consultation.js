/**
 * Creates a synthetic TEST patient, all the way through "first consultation
 * complete" - the exact point where a real dietician can open the Create
 * Diet Plan wizard and generate a plan for them. Exists purely to let a
 * human manually test the v4.0 wizard flow (Targets -> Generate -> Refine
 * Portions -> Timeline -> Finalize) against a real dietician account
 * without needing a real patient to sign up and fill out a real
 * consultation first.
 *
 * Bypasses the app's HTTP/Supabase-auth signup flow entirely - this patient
 * has NO Supabase account and can never log into the user app. It exists
 * only as backend data for the DIETICIAN side to see and act on. Three
 * documents, matching exactly what controllers/dietician/dietPlanController.js's
 * createAndGenerateDietPlan and getPatientProfile actually read (see the
 * "Diet Plan v4.0" plan doc's Phase notes / this script's own comments for
 * why each field is here):
 *
 *   - User (role:'patient') - profile.fullName/gender/dateOfBirth +
 *     healthProfile.weight/height/activityLevel/targetWeight/primaryGoal
 *     are what the wizard's Targets step needs to compute real (non-zero)
 *     calorie/macro tiers. bmi/weightIndex are auto-computed by the
 *     model's own pre('validate') hook from weight/height - not set here.
 *   - DietPlanRequest - membershipPlan must contain 'silver'/'golden'/
 *     'platinum' (case-insensitive substring, see utils/membershipTiers.js)
 *     or createAndGenerateDietPlan 400s with "no recognized membership
 *     plan". dieticianId is what scopes this patient into the target
 *     dietician's patient list (assertDieticianOwnsPatient/
 *     listPatientsForDietician - a DietPlanRequest is the actual visibility
 *     gate, not anything on User itself).
 *   - FirstConsultation - patient+dietician only; every other section has
 *     schema-level defaults. There is no status/completed flag on this
 *     model - completion is purely "the document exists", confirmed by
 *     reading controllers/dietician/firstConsultationController.js and
 *     createAndGenerateDietPlan's own gate (just FirstConsultation.findById
 *     + patient-match, nothing else).
 *
 * Clearly identifiable so it's easy to find and delete later: full name is
 * prefixed "[TEST]", email is under the +test-patient-qa@ local-part
 * convention.
 *
 * Usage:
 *   node scripts/seed-test-patient-first-consultation.js                          # dry run
 *   node scripts/seed-test-patient-first-consultation.js --execute                # actually write
 *   node scripts/seed-test-patient-first-consultation.js --execute --dietician-email=someone@else.com
 *   node scripts/seed-test-patient-first-consultation.js --execute --membership=Platinum
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
const MEMBERSHIP_TIER = argValue('membership', 'Golden'); // Silver | Golden | Platinum

async function main() {
  console.log(EXECUTE ? '=== EXECUTING test-patient creation ===' : '=== DRY RUN (pass --execute to write) ===');
  console.log(`Target dietician: ${DIETICIAN_EMAIL}`);
  console.log(`Membership tier: ${MEMBERSHIP_TIER}`);

  console.log('Connecting to MongoDB...');
  const tlsCAFile = connectDB.resolveTlsCAFile();
  const connectOptions = tlsCAFile ? { tls: true, tlsCAFile } : {};
  await mongoose.connect(process.env.MONGODB_URI, connectOptions);
  console.log('Connected.');

  try {
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
    console.log('  FirstConsultation: patient + dietician only (rest defaults)');

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
        weight: 72,
        height: 165,
        primaryGoal: 'Weight Loss',
        targetWeight: '62',
        activityLevel: 'Moderately Activity',
        healthConcerns: [],
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
    console.log('\nTo clean this up later, delete these 3 documents by the above ids, or run:');
    console.log(`  db.users.deleteOne({_id: ObjectId("${patient._id}")})`);
    console.log(`  db.dietplanrequests.deleteOne({_id: ObjectId("${dietPlanRequest._id}")})`);
    console.log(`  db.firstconsultations.deleteOne({_id: ObjectId("${firstConsultation._id}")})`);
    console.log('  (and any DietPlan later created for this patientId)');
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error('Failed:', err);
  process.exit(1);
});
