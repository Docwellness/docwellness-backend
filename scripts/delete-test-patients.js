/**
 * Bulk delete every synthetic TEST patient and everything under them -
 * generalizes seed-test-patient-first-consultation.js's own per-patient
 * `--delete=<id>` mode to "every patient matching a test marker", for
 * clearing out QA patients accumulated across many manual test sessions
 * (v4.0 wizard testing, etc.) in one pass instead of one id at a time.
 *
 * Matches on User.profile.fullName starting with "[TEST]" by default - the
 * exact, deliberate marker seed-test-patient-first-consultation.js stamps
 * on every synthetic patient it creates (see that script's
 * `patientFullName`). Deliberately NOT a broader/fuzzier match (e.g. any
 * name containing "test") - a real patient could coincidentally be named
 * that, and this script has no way to tell the difference. Pass
 * --pattern=<regex> to widen it for other known synthetic-patient naming
 * schemes (e.g. create-test-renewal-patient.js's "Test Week4 Renewal"), but
 * always read the dry-run list first - a wider pattern is your judgment
 * call, not this script's.
 *
 * Deletes the same cascade seed-test-patient-first-consultation.js's
 * --delete mode does, per matched patient: PlanItem/SupplementItem ->
 * MealSlotPlan -> DayPlan -> DietPlan, DietPlanRequest, FirstConsultation,
 * MealLog, ManualPaymentProof, then the User itself.
 *
 * ALWAYS dry-run first (default) and read the list before passing --execute
 * - this is irreversible, and doubly so if MONGODB_URI happens to be
 * pointed at production rather than dev when you run it.
 *
 * Usage:
 *   node scripts/delete-test-patients.js                          # dry run, default [TEST] pattern
 *   node scripts/delete-test-patients.js --execute                # actually delete
 *   node scripts/delete-test-patients.js --pattern="^\[TEST\]|^Test "   # widen the match (dry run)
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

const PATTERN = argValue('pattern', '^\\[TEST\\]');

async function run() {
  const {
    User,
    DietPlanRequest,
    FirstConsultation,
    DietPlan,
    DayPlan,
    MealSlotPlan,
    PlanItem,
    SupplementItem,
    MealLog,
    ManualPaymentProof,
  } = require('../models');

  const nameRegex = new RegExp(PATTERN, 'i');
  const patients = await User.find({ role: 'patient', 'profile.fullName': nameRegex }).select('_id email profile.fullName');

  console.log(`Pattern: /${PATTERN}/i`);
  console.log(`Found ${patients.length} matching patient(s):`);
  for (const patient of patients) {
    console.log(`  - ${patient.profile?.fullName || '(no name)'} <${patient.email}> (${patient._id})`);
  }

  if (patients.length === 0) {
    console.log('\nNothing to delete.');
    return;
  }

  const patientIds = patients.map((p) => p._id);
  const dietPlans = await DietPlan.find({ patientId: { $in: patientIds } }).select('_id');
  const dietPlanIds = dietPlans.map((p) => p._id);
  const dayPlans = await DayPlan.find({ dietPlanId: { $in: dietPlanIds } }).select('_id');
  const dayPlanIds = dayPlans.map((d) => d._id);
  const mealSlots = await MealSlotPlan.find({ dayPlanId: { $in: dayPlanIds } }).select('_id');
  const mealSlotIds = mealSlots.map((m) => m._id);

  console.log('\nWill also delete:');
  console.log(`  DietPlan(s): ${dietPlanIds.length}`);
  console.log(`  DayPlan(s): ${dayPlanIds.length}`);
  console.log(`  MealSlotPlan(s): ${mealSlotIds.length}`);
  console.log(`  PlanItem(s)/SupplementItem(s) under those meal slots`);
  console.log(`  DietPlanRequest(s)/FirstConsultation(s)/MealLog(s)/ManualPaymentProof(s) for these patients`);

  if (!EXECUTE) {
    console.log('\n=== DRY RUN - pass --execute to actually delete ===');
    return;
  }

  await PlanItem.deleteMany({ mealSlotId: { $in: mealSlotIds } });
  await SupplementItem.deleteMany({ mealSlotId: { $in: mealSlotIds } });
  await MealSlotPlan.deleteMany({ dayPlanId: { $in: dayPlanIds } });
  await DayPlan.deleteMany({ dietPlanId: { $in: dietPlanIds } });
  await DietPlan.deleteMany({ patientId: { $in: patientIds } });
  await DietPlanRequest.deleteMany({ patient: { $in: patientIds } });
  await FirstConsultation.deleteMany({ patient: { $in: patientIds } });
  await MealLog.deleteMany({ patientId: { $in: patientIds } });
  await ManualPaymentProof.deleteMany({ patient: { $in: patientIds } });
  await User.deleteMany({ _id: { $in: patientIds } });

  console.log(`\n=== DELETED ${patientIds.length} patient(s) and all related data ===`);
}

async function main() {
  console.log(EXECUTE ? '=== EXECUTING bulk test-patient deletion ===' : '=== DRY RUN (pass --execute to write) ===');

  console.log('Connecting to MongoDB...');
  const tlsCAFile = connectDB.resolveTlsCAFile();
  const connectOptions = tlsCAFile ? { tls: true, tlsCAFile } : {};
  await mongoose.connect(process.env.MONGODB_URI, connectOptions);
  console.log('Connected.');

  try {
    await run();
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error('Failed:', err);
  process.exit(1);
});
