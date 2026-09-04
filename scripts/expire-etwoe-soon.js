/**
 * TEST-DATA TWEAK (reversible): pulls the "Etwoe" patient's current paid
 * cycle's subscriptionExpiresAt in to `now + DAYS_FROM_NOW` so the patient
 * app's Home screen shows the "Request diet plan" renewal button alongside
 * Log Meal / Log Exercise (it appears once the cycle is within
 * kRenewalWindowDays / 3 days of expiry - see docwellness-user
 * home_controller.dart renewalDue / home_view.dart Paid branch).
 *
 * Touches exactly two fields on two documents:
 *   DietPlanRequest.subscriptionExpiresAt
 *   User.status.subscriptionExpiresAt
 * The original values are written to scripts/.etwoe-expiry-backup.json so
 * `--restore` can put them back.
 *
 * Usage:
 *   node scripts/expire-etwoe-soon.js              # dry run - shows what it would do
 *   node scripts/expire-etwoe-soon.js --execute    # apply (2 days from now)
 *   node scripts/expire-etwoe-soon.js --execute --days=5
 *   node scripts/expire-etwoe-soon.js --restore --execute   # revert
 */

require('dotenv').config();
require('dns').setServers(['8.8.8.8', '1.1.1.1']);
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');

const EXECUTE = process.argv.includes('--execute');
const RESTORE = process.argv.includes('--restore');
const daysArg = process.argv.find((a) => a.startsWith('--days='));
const DAYS_FROM_NOW = daysArg ? Number(daysArg.split('=')[1]) : 2;
const BACKUP_FILE = path.join(__dirname, '.etwoe-expiry-backup.json');
const MS_PER_DAY = 24 * 60 * 60 * 1000;

async function main() {
  console.log(EXECUTE ? '=== EXECUTING ===' : '=== DRY RUN (pass --execute to write) ===');
  console.log('Connecting to MongoDB...');
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected.\n');

  try {
    const { User, DietPlanRequest } = require('../models');

    const patient = await User.findOne({
      role: 'patient',
      'profile.fullName': /etwoe/i,
    });
    if (!patient) throw new Error('No patient with "Etwoe" in profile.fullName found.');
    console.log(`Patient: ${patient.profile?.fullName} <${patient.email}> (${patient._id})`);

    // The cycle Home reads from: newest active/paid request for this patient.
    const request = await DietPlanRequest.findOne({
      patient: patient._id,
      status: { $in: ['Paid', 'PartiallyPaid'] },
    }).sort({ createdAt: -1 });
    if (!request) throw new Error('No Paid/PartiallyPaid DietPlanRequest for this patient.');

    console.log(`DietPlanRequest: ${request._id} (status ${request.status})`);
    console.log(`  request.subscriptionExpiresAt : ${request.subscriptionExpiresAt}`);
    console.log(`  user.status.subscriptionExpiresAt: ${patient.status?.subscriptionExpiresAt}`);

    if (RESTORE) {
      if (!fs.existsSync(BACKUP_FILE)) throw new Error(`No backup file at ${BACKUP_FILE} - nothing to restore.`);
      const backup = JSON.parse(fs.readFileSync(BACKUP_FILE, 'utf8'));
      if (backup.requestId !== String(request._id)) {
        throw new Error(`Backup is for request ${backup.requestId}, current request is ${request._id}.`);
      }
      console.log(`\nWould restore:`);
      console.log(`  request.subscriptionExpiresAt -> ${backup.requestExpiresAt}`);
      console.log(`  user.status.subscriptionExpiresAt -> ${backup.userExpiresAt}`);
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
    console.log(`\nWould set both fields to: ${newExpiry.toISOString()} (${DAYS_FROM_NOW} days from now)`);

    if (!EXECUTE) {
      console.log('\nDry run - no writes. Re-run with --execute to apply.');
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
    console.log(`Original values backed up to ${BACKUP_FILE}`);

    request.subscriptionExpiresAt = newExpiry;
    await request.save();
    await User.updateOne(
      { _id: patient._id },
      { $set: { 'status.subscriptionExpiresAt': newExpiry } }
    );

    console.log('\n=== DONE ===');
    console.log('Reload the patient app - Home should now show "Request diet plan" under Log Meal / Log Exercise.');
    console.log('Revert with: node scripts/expire-etwoe-soon.js --restore --execute');
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
