/**
 * DESTRUCTIVE, IRREVERSIBLE. Removes every `role:'patient'` User and all
 * data referencing them (see utils/patientDataDeletion.js for the exact
 * per-collection list), plus their Supabase auth identities. Dieticians,
 * admins and the recipe / ingredient / exercise / food catalog are left
 * untouched.
 *
 * Intended for a pre-launch reset of the production database, which still
 * carries dev/test patients from the Oracle cutover (docs/db-migration-oracle.md).
 *
 * Targets whichever database MONGODB_URI points at - there is NO
 * prod-specific override, on purpose: run this with prod's own
 * MONGODB_URI / MONGODB_TLS_CA_BASE64 already in the environment (e.g. via
 * `docker exec` inside the prod container), the same way
 * scripts/cleanup-prod-test-users.js and scripts/createDieticianAccount.js do.
 *
 * Usage:
 *   node scripts/delete-all-patients.js                  # dry run - counts only
 *   node scripts/delete-all-patients.js --execute        # delete (asks for typed confirmation)
 *   node scripts/delete-all-patients.js --execute --yes  # delete, skip the typed prompt (CI / non-TTY)
 *
 * Flags:
 *   --execute           actually delete (without it: dry run, nothing changes)
 *   --yes               skip the interactive "type DELETE ALL N PATIENTS" prompt
 *   --keep-supabase     do NOT delete Supabase auth identities (Mongo only)
 *   --purge-cloudinary  best-effort delete of each patient's Cloudinary folder
 *                       (docwellness/<userId>/*) - slow, off by default
 */

require('dns').setServers(['8.8.8.8', '1.1.1.1']);
require('dotenv').config();

const readline = require('readline');
const connectDB = require('../config/database');
const {
  CATEGORY_KEYS,
  countPatientData,
  deletePatientData,
} = require('../utils/patientDataDeletion');

const EXECUTE = process.argv.includes('--execute');
const SKIP_PROMPT = process.argv.includes('--yes');
const KEEP_SUPABASE = process.argv.includes('--keep-supabase');
const PURGE_CLOUDINARY = process.argv.includes('--purge-cloudinary');

function describeTarget() {
  const uri = process.env.MONGODB_URI || '';
  // mongodb+srv://user:pass@host/dbname?opts  |  mongodb://host:port/dbname
  const m = uri.match(/^mongodb(?:\+srv)?:\/\/(?:[^@]*@)?([^/?]+)(?:\/([^/?]+))?/i);
  return { host: m && m[1], db: m && m[2] };
}

async function promptTypedConfirmation(expected) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((resolve) => {
    rl.question(`\nType exactly "${expected}" to proceed: `, resolve);
  });
  rl.close();
  return answer.trim() === expected;
}

async function purgeCloudinaryFolders(ids) {
  let cloudinary;
  try {
    cloudinary = require('../config/cloudinary');
  } catch (err) {
    console.warn('  Cloudinary not configured - skipping asset purge.', err.message);
    return;
  }
  let ok = 0;
  let failed = 0;
  for (const id of ids) {
    const prefix = `docwellness/${id}/`;
    try {
      await cloudinary.api.delete_resources_by_prefix(prefix);
      await cloudinary.api.delete_folder(`docwellness/${id}`).catch(() => {});
      ok += 1;
    } catch (err) {
      failed += 1;
      console.warn(`  Cloudinary purge failed for ${prefix}:`, err.message);
    }
  }
  console.log(`  Cloudinary: purged ${ok} folder(s), ${failed} failed.`);
}

async function deleteSupabaseIdentities(patients) {
  const { getSupabaseAdmin } = require('../utils/supabaseAuth');
  const admin = getSupabaseAdmin();
  let ok = 0;
  let failed = 0;
  for (const p of patients) {
    if (!p.supabaseUserId) continue;
    try {
      const { error } = await admin.auth.admin.deleteUser(p.supabaseUserId);
      if (error) throw error;
      ok += 1;
    } catch (err) {
      failed += 1;
      console.warn(`  Supabase delete failed for ${p.email} (${p.supabaseUserId}):`, err.message);
    }
  }
  console.log(`  Supabase: deleted ${ok} identit(y/ies), ${failed} failed.`);
}

async function main() {
  console.log(EXECUTE ? '=== EXECUTING full patient wipe ===' : '=== DRY RUN (pass --execute to delete) ===');

  const { host, db } = describeTarget();
  if (!host) {
    console.error('Could not parse MONGODB_URI - aborting.');
    process.exit(1);
  }
  console.log(`Target: ${host}${db ? ` / ${db}` : ' (db name not in URI)'}`);

  await connectDB();
  const { User } = require('../models');

  const roleCounts = await User.aggregate([{ $group: { _id: '$role', n: { $sum: 1 } } }]);
  console.log('\nUser accounts:');
  roleCounts.forEach((r) => console.log(`  ${r._id || '(no role)'}: ${r.n}`));

  const patients = await User.find({ role: 'patient' })
    .select('_id email supabaseUserId')
    .lean();

  if (patients.length === 0) {
    console.log('\nNo patient accounts found - nothing to do.');
    process.exit(0);
  }

  const ids = patients.map((p) => p._id);
  console.log(`\n${patients.length} patient account(s) will be removed.`);

  const counts = await countPatientData(ids, CATEGORY_KEYS);
  counts.users = patients.length;
  console.log('\n=== Would delete ===');
  console.table(
    Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .map(([collection, matched]) => ({ collection, matched }))
  );

  if (!EXECUTE) {
    console.log('\nDry run - nothing deleted. Re-run with --execute to actually delete.');
    console.log('Dieticians, admins and the recipe/exercise/food catalog are never touched.');
    process.exit(0);
  }

  if (!SKIP_PROMPT) {
    if (!process.stdin.isTTY) {
      console.error('\n--execute in a non-interactive shell requires --yes. Aborting.');
      process.exit(1);
    }
    const phrase = `DELETE ALL ${patients.length} PATIENTS`;
    const confirmed = await promptTypedConfirmation(phrase);
    if (!confirmed) {
      console.log('Confirmation did not match - aborting. Nothing deleted.');
      process.exit(1);
    }
  }

  console.log('\nDeleting patient-owned data...');
  const deleted = await deletePatientData(ids, CATEGORY_KEYS, { execute: true });

  console.log('Deleting patient User documents...');
  const userRes = await User.deleteMany({ _id: { $in: ids } });
  deleted.users = userRes.deletedCount || 0;

  if (!KEEP_SUPABASE) {
    console.log('Deleting Supabase auth identities...');
    await deleteSupabaseIdentities(patients);
  }

  if (PURGE_CLOUDINARY) {
    console.log('Purging Cloudinary folders...');
    await purgeCloudinaryFolders(ids);
  }

  const { logAuditEvent } = require('../utils/auditLog');
  logAuditEvent('all_patients_wiped', { patientCount: patients.length, deleted });

  console.log('\n=== DONE ===');
  console.table(
    Object.entries(deleted)
      .sort((a, b) => b[1] - a[1])
      .map(([collection, removed]) => ({ collection, removed }))
  );
  console.log('Dieticians, admins and the recipe/exercise/food catalog were not touched.');
  process.exit(0);
}

main().catch((err) => {
  console.error('Wipe failed:', err);
  process.exit(1);
});
