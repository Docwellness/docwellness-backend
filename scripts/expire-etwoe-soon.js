/**
 * TEST-DATA TWEAK (reversible) for exercising the diet-plan renewal flow
 * against the "Etwoe" patient.
 *
 * Default: pulls the current cycle's subscriptionExpiresAt in to
 * `now + DAYS_FROM_NOW` (2) so the patient app's Home shows the
 * "Request diet plan" renewal button (it appears within
 * kRenewalWindowDays / 3 days of expiry - see docwellness-user
 * home_controller.dart renewalDue).
 *   Touches: DietPlanRequest.subscriptionExpiresAt +
 *            User.status.subscriptionExpiresAt
 *   Originals backed up to scripts/.etwoe-expiry-backup.json (--restore).
 *
 * --reset-paid: puts a half-finished renewal back to a clean paid cycle
 * (status Paid, payment fields cleared, pendingDietPlanId dropped, any
 * Draft next-cycle plan deleted) so the patient-side flow can be tested
 * again from the start. Combine with the default expiry pull in one run.
 *
 * Finds the newest DietPlanRequest with hasActivePlan:true (the cycle Home
 * and the dietician profile actually read), regardless of its current
 * status - a renewal in progress has flipped it to Unpaid.
 *
 * Connects via connectDB() (config/database.js) for prod's self-hosted
 * Mongo TLS. Run from Coolify's Terminal tab for prod.
 *
 * Usage:
 *   node scripts/expire-etwoe-soon.js                       # dry run
 *   node scripts/expire-etwoe-soon.js --execute             # expiry -> now+2d
 *   node scripts/expire-etwoe-soon.js --execute --days=5
 *   node scripts/expire-etwoe-soon.js --execute --reset-paid   # clean slate + expiry pull
 *   node scripts/expire-etwoe-soon.js --restore --execute      # revert expiry
 */

require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/database');
const fs = require('fs');
const path = require('path');

const EXECUTE = process.argv.includes('--execute');
const RESTORE = process.argv.includes('--restore');
const RESET_PAID = process.argv.includes('--reset-paid');
const daysArg = process.argv.find((a) => a.startsWith('--days='));
const DAYS_FROM_NOW = daysArg ? Number(daysArg.split('=')[1]) : 2;
const BACKUP_FILE = path.join(__dirname, '.etwoe-expiry-backup.json');
const MS_PER_DAY = 24 * 60 * 60 * 1000;

async function main() {
  console.log(EXECUTE ? '=== EXECUTING ===' : '=== DRY RUN (pass --execute to write) ===');
  console.log('Connecting to MongoDB...');
  await connectDB();
  console.log('Connected.\n');

  try {
    const { User, DietPlanRequest, DietPlan } = require('../models');

    const patient = await User.findOne({
      role: 'patient',
      'profile.fullName': /etwoe/i,
    });
    if (!patient) throw new Error('No patient with "Etwoe" in profile.fullName found.');
    console.log(`Patient: ${patient.profile?.fullName} <${patient.email}> (${patient._id})`);

    // The cycle Home / the dietician profile read from: newest request that
    // still has an active plan. A renewal in progress has flipped its
    // status to Unpaid, so don't filter on status here.
    let request = await DietPlanRequest.findOne({
      patient: patient._id,
      hasActivePlan: true,
    }).sort({ createdAt: -1 });
    if (!request) {
      request = await DietPlanRequest.findOne({ patient: patient._id }).sort({ createdAt: -1 });
    }
    if (!request) throw new Error('This patient has no DietPlanRequest at all.');

    console.log(`DietPlanRequest: ${request._id}`);
    console.log(`  status               : ${request.status}`);
    console.log(`  hasActivePlan        : ${request.hasActivePlan}`);
    console.log(`  membershipPlan       : ${request.membershipPlan}`);
    console.log(`  subscriptionExpiresAt: ${request.subscriptionExpiresAt}`);
    console.log(`  user.status.requestStatus         : ${patient.status?.requestStatus}`);
    console.log(`  user.status.pendingDietPlanId     : ${patient.status?.pendingDietPlanId}`);
    console.log(`  user.status.subscriptionExpiresAt : ${patient.status?.subscriptionExpiresAt}`);

    if (RESTORE) {
      if (!fs.existsSync(BACKUP_FILE)) throw new Error(`No backup file at ${BACKUP_FILE} - nothing to restore.`);
      const backup = JSON.parse(fs.readFileSync(BACKUP_FILE, 'utf8'));
      if (backup.requestId !== String(request._id)) {
        throw new Error(`Backup is for request ${backup.requestId}, current request is ${request._id}.`);
      }
      console.log(`\nWould restore subscriptionExpiresAt -> ${backup.requestExpiresAt}`);
      if (EXECUTE) {
        request.subscriptionExpiresAt = backup.requestExpiresAt ? new Date(backup.requestExpiresAt) : null;
        await request.save();
        await User.updateOne(
          { _id: patient._id },
          { $set: { 'status.subscriptionExpiresAt': backup.userExpiresAt ? new Date(backup.userExpiresAt) : null } }
        );
        fs.unlinkSync(BACKUP_FILE);
        console.log('\nRestored. Backup file deleted.');
      } else {
        console.log('\nDry run - re-run with --execute to restore.');
      }
      return;
    }

    const newExpiry = new Date(Date.now() + DAYS_FROM_NOW * MS_PER_DAY);

    console.log('\nWould:');
    if (RESET_PAID) {
      console.log('  - reset the request to a clean Paid cycle (status Paid, payment fields cleared)');
      console.log('  - clear user.status.pendingDietPlanId + set requestStatus Paid');
      const draftNext = await DietPlan.find({
        patientId: patient._id,
        status: 'Draft',
      }).select('_id cycleNumber').lean();
      if (draftNext.length) {
        console.log(`  - delete ${draftNext.length} Draft next-cycle plan(s): ${draftNext.map((d) => `${d._id}(cycle ${d.cycleNumber})`).join(', ')}`);
      }
    }
    console.log(`  - set both subscriptionExpiresAt fields to ${newExpiry.toISOString()} (${DAYS_FROM_NOW}d from now)`);

    if (!EXECUTE) {
      console.log('\nDry run - no writes. Re-run with --execute.');
      return;
    }

    fs.writeFileSync(
      BACKUP_FILE,
      JSON.stringify(
        {
          savedAt: new Date().toISOString(),
          patientId: String(patient._id),
          requestId: String(request._id),
          requestExpiresAt: request.subscriptionExpiresAt || null,
          userExpiresAt: patient.status?.subscriptionExpiresAt || null,
        },
        null,
        2
      )
    );
    console.log(`\nOriginal expiry values backed up to ${BACKUP_FILE}`);

    if (RESET_PAID) {
      await DietPlan.deleteMany({ patientId: patient._id, status: 'Draft' });
      request.status = 'Paid';
      request.paymentRequested = false;
      request.paymentRequestedAt = null;
      request.latestPaymentStatus = 'Paid';
      request.hasActivePlan = true;
      await User.updateOne(
        { _id: patient._id },
        {
          $set: { 'status.requestStatus': 'Paid', 'status.pendingDietPlanId': null },
        }
      );
      console.log('Reset the request to a clean Paid cycle.');
    }

    request.subscriptionExpiresAt = newExpiry;
    await request.save();
    await User.updateOne(
      { _id: patient._id },
      { $set: { 'status.subscriptionExpiresAt': newExpiry } }
    );

    console.log('\n=== DONE ===');
    console.log('Reload the patient app - Home should show "Request diet plan" under Log Meal / Log Exercise.');
    console.log('Revert expiry with: node scripts/expire-etwoe-soon.js --restore --execute');
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
