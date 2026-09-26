/**
 * Backdates one patient's ExercisePlan.startDate to match their DietPlan's
 * startDate. No live endpoint accepts a past startDate for ExercisePlan
 * (upsertExercisePlan doesn't take one; updateDietStartDate's cascade
 * rejects past dates the same as the diet plan itself) - see
 * openspec/changes/seed-patient-history in docwellness-specs. This is the
 * one direct-DB write that companion script scripts/seed-patient-history.js
 * cannot do over the API.
 *
 * ── Connection ──────────────────────────────────────────────────────────────
 * Two modes, same convention as scripts/seed-prod-videos.js:
 *
 *   A. From your machine, against remote prod:
 *        set PROD_MONGODB_URI in the shell, then:
 *        node scripts/patch-exercise-plan-startdate.js --email=<patient email> [--execute]
 *
 *   B. Inside the deployed backend container (Coolify "Execute Command"),
 *      where MONGODB_URI already points at prod:
 *        node scripts/patch-exercise-plan-startdate.js --use-default-uri --email=<patient email> [--execute]
 *
 * Dry run by default - prints the current and target startDate without
 * writing. Pass --execute to actually update.
 */

const USE_DEFAULT_URI = process.argv.includes('--use-default-uri');

require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/database');

const EXECUTE = process.argv.includes('--execute');

function arg(name, fallback) {
  const found = process.argv.find((a) => a.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : fallback;
}

const TARGET_EMAIL = arg('email', 'pawarbhushan08@gmail.com');
const EXPLICIT_START_DATE = arg('start-date', null);

async function openConnection() {
  const tlsCAFile = connectDB.resolveTlsCAFile();
  const tlsOptions = tlsCAFile ? { tls: true, tlsCAFile } : {};

  const uri = USE_DEFAULT_URI ? process.env.MONGODB_URI : process.env.PROD_MONGODB_URI;

  if (!uri) {
    console.error(
      USE_DEFAULT_URI
        ? 'MONGODB_URI is not set in this environment.'
        : 'PROD_MONGODB_URI must be set (or run inside the deployed container with --use-default-uri).'
    );
    process.exit(1);
  }

  if (uri.startsWith('mongodb+srv://')) {
    require('dns').setServers(['8.8.8.8', '1.1.1.1']);
  }

  const conn = mongoose.createConnection(uri, tlsOptions);
  await conn.asPromise();
  return conn;
}

async function main() {
  console.log(EXECUTE ? '=== EXECUTING startDate patch ===' : '=== DRY RUN (pass --execute to write) ===');

  const conn = await openConnection();
  console.log(
    `Connected to DB "${conn.name}" @ ${conn.host}:${conn.port}` +
      (USE_DEFAULT_URI ? '  (via MONGODB_URI)' : '  (via PROD_MONGODB_URI)')
  );

  try {
    const users = conn.collection('users');
    const patient = await users.findOne({ email: TARGET_EMAIL, role: 'patient' });
    if (!patient) {
      console.error(`No patient found with email "${TARGET_EMAIL}" - aborting.`);
      process.exitCode = 1;
      return;
    }
    console.log(`Patient: ${patient.email} (${patient._id})`);

    let targetStartDate;
    if (EXPLICIT_START_DATE) {
      targetStartDate = new Date(`${EXPLICIT_START_DATE}T00:00:00.000Z`);
      if (Number.isNaN(targetStartDate.getTime())) {
        console.error(`--start-date must be YYYY-MM-DD, got "${EXPLICIT_START_DATE}"`);
        process.exitCode = 1;
        return;
      }
    } else {
      const dietPlans = conn.collection('dietplans');
      const dietPlan = await dietPlans.findOne(
        { patientId: patient._id, status: 'Active' },
        { sort: { cycleNumber: -1 }, projection: { startDate: 1 } }
      );
      if (!dietPlan) {
        console.error('No Active DietPlan found for this patient - pass --start-date=YYYY-MM-DD explicitly, or run seed-patient-history.js first.');
        process.exitCode = 1;
        return;
      }
      targetStartDate = dietPlan.startDate;
      console.log(`Using this patient's Active DietPlan.startDate: ${targetStartDate.toISOString().slice(0, 10)}`);
    }

    const exercisePlans = conn.collection('exerciseplans');
    const exercisePlan = await exercisePlans.findOne(
      { patientId: patient._id, status: { $ne: 'Completed' } },
      { sort: { createdAt: -1 } }
    );
    if (!exercisePlan) {
      console.error('No non-Completed ExercisePlan found for this patient - run seed-patient-history.js first.');
      process.exitCode = 1;
      return;
    }

    console.log('\n=== PLAN ===');
    console.table([
      {
        exercisePlanId: String(exercisePlan._id),
        currentStartDate: new Date(exercisePlan.startDate).toISOString().slice(0, 10),
        targetStartDate: targetStartDate.toISOString().slice(0, 10),
        status: exercisePlan.status,
      },
    ]);

    if (!EXECUTE) {
      console.log('\nDry run - no writes. Re-run with --execute to patch.');
      return;
    }

    await exercisePlans.updateOne({ _id: exercisePlan._id }, { $set: { startDate: targetStartDate } });
    console.log(`\nUpdated ExercisePlan ${exercisePlan._id}: startDate -> ${targetStartDate.toISOString().slice(0, 10)}`);
  } finally {
    await conn.close();
  }
}

main().catch((err) => {
  console.error('Patch failed:', err);
  process.exit(1);
});
