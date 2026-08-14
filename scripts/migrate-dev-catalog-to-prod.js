/**
 * One-time migration: copies dietician-authored catalog/reference content
 * from dev's MongoDB into prod's, remapping each document's dietician
 * reference from dev's dietician _id to the real prod dietician's _id
 * (created via scripts/createDieticianAccount.js against prod first - see
 * the release plan's Phase 3, which this script's Phase 4 depends on).
 *
 * Source (dev) is read via the normal Mongoose models on the default
 * connection (MONGODB_URI). Target (prod) is written via a second raw
 * connection (PROD_MONGODB_URI) using each model's own `.collection.name`
 * and the native driver directly - bypassing Mongoose schema validation on
 * write, since every document was already validated when it was created on
 * dev. `insertMany` runs with `ordered: false` and ObjectID/`_id` preserved
 * as-is, so a document already present in prod (e.g. a re-run, or a
 * ConsultationFormTemplate prod auto-seeded on the dietician's first
 * login - see that model's unique `dietician` index) reports as a
 * duplicate-key skip rather than crashing the whole run - this makes
 * re-running safe, not just tolerated.
 *
 * Deliberately excludes (not silently - see the release plan's own
 * discussion): `Review` (dangling `patientId` in addition to
 * `dieticianId` - no real prod patient exists yet to remap it onto; real
 * reviews should accumulate from real prod patients instead), and every
 * patient/account-scoped model (`User`, `Chat`, `Conversation`, `CheckIn`,
 * `CustomFoodRequest`, `DietPlan`, `DietPlanRequest`, `ExerciseLog`,
 * `ExercisePlan`, `FirstConsultation`, `Goal`, `JourneyImage`,
 * `ManualPaymentProof`, `MealLog`, `Milestone`, `MilestoneTask`,
 * `NeedAttentionLog`, `Notification`, `Nudge`, `Progress`, `WaterLog`,
 * `GenerationLog`) - meaningless or harmful to copy without real
 * corresponding prod users.
 *
 * Usage:
 *   node scripts/migrate-dev-catalog-to-prod.js --prod-dietician-id=<id>            # dry run
 *   node scripts/migrate-dev-catalog-to-prod.js --prod-dietician-id=<id> --execute  # actually write
 *
 * Requires MONGODB_URI (dev/source, from .env as usual) and
 * PROD_MONGODB_URI (prod/target) as separate env vars - PROD_MONGODB_URI is
 * never defaulted or guessed; the script refuses to run without it
 * explicitly set, so this can never accidentally point at the wrong
 * database.
 */

// Same DNS fix as seed-home-workout-exercises.js - the default system
// resolver on this machine doesn't handle mongodb+srv://'s SRV/TXT lookups.
require('dns').setServers(['8.8.8.8', '1.1.1.1']);

require('dotenv').config();
const mongoose = require('mongoose');

const EXECUTE = process.argv.includes('--execute');
const dieticianArg = process.argv.find((a) => a.startsWith('--prod-dietician-id='));
const PROD_DIETICIAN_ID = dieticianArg ? dieticianArg.split('=')[1] : null;

// Every model here is dietician-scoped catalog/reference content, safe and
// meaningful to carry over into a fresh prod database - see this file's own
// doc comment above for the full excluded list and why. The field name
// holding the dietician reference isn't uniform across models (only
// ConsultationFormTemplate differs, using `dietician` instead of
// `dieticianId`), so it's spelled out explicitly per model rather than
// assumed.
const INCLUDE_MODELS = [
  { name: 'Article', dieticianField: 'dieticianId' },
  { name: 'ConsultationFormTemplate', dieticianField: 'dietician' },
  { name: 'Coupon', dieticianField: 'dieticianId' },
  { name: 'Exercise', dieticianField: 'dieticianId' },
  { name: 'Ingredient', dieticianField: 'dieticianId' },
  { name: 'Recipe', dieticianField: 'dieticianId' },
  { name: 'Quote', dieticianField: 'dieticianId' },
  { name: 'SocialMediaPost', dieticianField: 'dieticianId' },
  { name: 'Video', dieticianField: 'dieticianId' },
];

async function main() {
  if (!PROD_DIETICIAN_ID || !mongoose.Types.ObjectId.isValid(PROD_DIETICIAN_ID)) {
    console.error(
      'Usage: node scripts/migrate-dev-catalog-to-prod.js --prod-dietician-id=<valid ObjectId> [--execute]'
    );
    process.exit(1);
  }
  if (EXECUTE && !process.env.PROD_MONGODB_URI) {
    console.error(
      'PROD_MONGODB_URI must be set (the prod database to migrate INTO) - refusing to guess or default this.'
    );
    process.exit(1);
  }

  console.log(EXECUTE ? '=== EXECUTING dev -> prod catalog migration ===' : '=== DRY RUN (pass --execute to write) ===');

  console.log('Connecting to dev (source) MongoDB...');
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected to dev.');

  // Dry run never touches prod at all - not just "no writes" but no
  // connection attempt either, so this can be run for a preview before
  // PROD_MONGODB_URI is even available yet.
  let prodConn = null;
  if (EXECUTE) {
    prodConn = mongoose.createConnection(process.env.PROD_MONGODB_URI);
    await prodConn.asPromise();
    console.log('Connected to prod.');
  }

  const newDieticianId = new mongoose.Types.ObjectId(PROD_DIETICIAN_ID);
  const summary = [];

  try {
    const models = require('../models');

    for (const { name, dieticianField } of INCLUDE_MODELS) {
      const Model = models[name];
      if (!Model) {
        console.warn(`  ! Model "${name}" not found in models/index.js - skipping`);
        continue;
      }

      const docs = await Model.find({}).lean();
      const collectionName = Model.collection.name;

      let skippedNoDietician = 0;
      const remapped = [];

      for (const doc of docs) {
        const oldDieticianId = doc[dieticianField];
        if (oldDieticianId == null) {
          skippedNoDietician++;
          continue;
        }
        remapped.push({ ...doc, [dieticianField]: newDieticianId });
      }

      let inserted = 0;
      let duplicates = 0;
      if (EXECUTE && remapped.length > 0) {
        const prodCollection = prodConn.collection(collectionName);
        try {
          const result = await prodCollection.insertMany(remapped, { ordered: false });
          inserted = result.insertedCount;
        } catch (bulkError) {
          // Duplicate-key errors (e.g. re-running, or a unique index like
          // ConsultationFormTemplate's `dietician` colliding with a
          // prod-auto-seeded default) land here even under ordered:false -
          // count what actually succeeded rather than treating this as a
          // total failure.
          inserted = bulkError.result?.insertedCount ?? bulkError.insertedDocs?.length ?? 0;
          duplicates = (bulkError.writeErrors || []).filter((e) => e.code === 11000).length;
          const otherErrors = (bulkError.writeErrors || []).filter((e) => e.code !== 11000);
          if (otherErrors.length > 0) {
            console.error(`  ! ${name}: ${otherErrors.length} non-duplicate write error(s):`, otherErrors[0].errmsg);
          }
        }
      }

      summary.push({
        model: name,
        collection: collectionName,
        foundInDev: docs.length,
        skippedNoDietician,
        ...(EXECUTE ? { insertedToProd: inserted, duplicateSkipped: duplicates } : { wouldInsert: remapped.length }),
      });
    }

    console.log('\n=== SUMMARY ===');
    console.table(summary);

    if (!EXECUTE) {
      console.log('\nThis was a dry run - no writes to prod. Re-run with --execute to actually migrate.');
    }
  } finally {
    await mongoose.disconnect();
    if (prodConn) await prodConn.close();
  }
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
