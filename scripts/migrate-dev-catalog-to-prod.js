/**
 * One-time migration: copies dietician-authored catalog/reference content
 * from dev's MongoDB into prod's, remapping each document's dietician
 * reference from dev's dietician _id to the real prod dietician's _id
 * (created via scripts/createDieticianAccount.js against prod first - see
 * the release plan's Phase 3, which this script's Phase 4 depends on).
 *
 * This is a DIFF, not a blind copy - prod is NOT an empty database. It was
 * originally cloned wholesale from the shared dev/prod Atlas cluster at the
 * self-hosted-Mongo cutover (see docs/db-migration-oracle.md), so it
 * already has most of dev's catalog, already correctly attributed to the
 * real prod dietician's _id (the clone predates any dieticianId remapping
 * need). Blindly re-inserting everything would duplicate all of it under
 * fresh _ids. Instead, for each included model, existing prod documents for
 * this dietician are read first and matched against dev's by a natural key
 * (see NATURAL_KEY below) - only genuinely new items (e.g. content added to
 * dev since the clone) get inserted.
 *
 * Source (dev) is read via the normal Mongoose models on the default
 * connection (MONGODB_URI). Target (prod) is read/written via a second
 * connection (PROD_MONGODB_URI), using connectDB's own resolveTlsCAFile
 * (see config/database.js) to build its TLS options - a raw
 * mongoose.createConnection() without this fails against prod's self-hosted
 * instance with a misleading "self-signed certificate in certificate chain"
 * error, since only connectDB knows to pass the custom CA prod requires.
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
const connectDB = require('../config/database');

const EXECUTE = process.argv.includes('--execute');
const dieticianArg = process.argv.find((a) => a.startsWith('--prod-dietician-id='));
const PROD_DIETICIAN_ID = dieticianArg ? dieticianArg.split('=')[1] : null;

// Every model here is dietician-scoped catalog/reference content, safe and
// meaningful to carry over into prod - see this file's own doc comment
// above for the full excluded list and why. dieticianField isn't uniform
// (only ConsultationFormTemplate differs). naturalKey is the field (or
// `null` for ConsultationFormTemplate's existence-only check, since it's
// already unique per dietician) used to detect "this already exists in
// prod, from the original clone or an earlier run" - not necessarily a
// unique DB index, just a good-enough real-world duplicate signal for each
// model's actual content.
const INCLUDE_MODELS = [
  { name: 'Article', dieticianField: 'dieticianId', naturalKey: 'title' },
  { name: 'ConsultationFormTemplate', dieticianField: 'dietician', naturalKey: null },
  { name: 'Coupon', dieticianField: 'dieticianId', naturalKey: 'code' },
  { name: 'Exercise', dieticianField: 'dieticianId', naturalKey: 'name' },
  { name: 'Ingredient', dieticianField: 'dieticianId', naturalKey: 'normalizedName' },
  { name: 'Recipe', dieticianField: 'dieticianId', naturalKey: 'name' },
  { name: 'Quote', dieticianField: 'dieticianId', naturalKey: 'text' },
  { name: 'SocialMediaPost', dieticianField: 'dieticianId', naturalKey: 'url' },
  { name: 'Video', dieticianField: 'dieticianId', naturalKey: 'title' },
];

async function main() {
  if (!PROD_DIETICIAN_ID || !mongoose.Types.ObjectId.isValid(PROD_DIETICIAN_ID)) {
    console.error(
      'Usage: node scripts/migrate-dev-catalog-to-prod.js --prod-dietician-id=<valid ObjectId> [--execute]'
    );
    process.exit(1);
  }
  if (!process.env.PROD_MONGODB_URI) {
    console.error(
      'PROD_MONGODB_URI must be set (the prod database to diff/migrate INTO) - refusing to guess or default this.'
    );
    process.exit(1);
  }

  console.log(EXECUTE ? '=== EXECUTING dev -> prod catalog diff-migration ===' : '=== DRY RUN (pass --execute to write) ===');

  console.log('Connecting to dev (source) MongoDB...');
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected to dev.');

  console.log('Connecting to prod (target) MongoDB...');
  const tlsCAFile = connectDB.resolveTlsCAFile();
  const prodOptions = tlsCAFile ? { tls: true, tlsCAFile } : {};
  const prodConn = mongoose.createConnection(process.env.PROD_MONGODB_URI, prodOptions);
  await prodConn.asPromise();
  console.log('Connected to prod.');

  const dieticianId = new mongoose.Types.ObjectId(PROD_DIETICIAN_ID);
  const summary = [];

  try {
    const models = require('../models');

    for (const { name, dieticianField, naturalKey } of INCLUDE_MODELS) {
      const Model = models[name];
      if (!Model) {
        console.warn(`  ! Model "${name}" not found in models/index.js - skipping`);
        continue;
      }
      const collectionName = Model.collection.name;
      const prodCollection = prodConn.collection(collectionName);

      // Prod's existing docs for this dietician - what's already there,
      // from the original clone or an earlier run of this script.
      const existingProdDocs = await prodCollection
        .find({ [dieticianField]: dieticianId })
        .project(naturalKey ? { [naturalKey]: 1 } : { _id: 1 })
        .toArray();
      const existingKeys = naturalKey
        ? new Set(existingProdDocs.map((d) => d[naturalKey]))
        : null;
      const alreadyHasOne = !naturalKey && existingProdDocs.length > 0;

      // Dev's docs for its own dietician (whichever dieticianId dev's data
      // actually uses - not assumed to be the same as prod's).
      const devDocs = await Model.find({ [dieticianField]: { $ne: null } }).lean();

      const toInsert = [];
      let alreadyInProd = 0;
      for (const doc of devDocs) {
        if (alreadyHasOne) {
          alreadyInProd++;
          continue;
        }
        if (naturalKey && existingKeys.has(doc[naturalKey])) {
          alreadyInProd++;
          continue;
        }
        toInsert.push({ ...doc, [dieticianField]: dieticianId });
        // A ConsultationFormTemplate is unique per dietician - the first
        // one queued this run also counts as "already have one" for the
        // rest of this loop, so dev never queues a second.
        if (!naturalKey) break;
      }

      let inserted = 0;
      if (EXECUTE && toInsert.length > 0) {
        const result = await prodCollection.insertMany(toInsert, { ordered: false });
        inserted = result.insertedCount;
      }

      summary.push({
        model: name,
        collection: collectionName,
        foundInDev: devDocs.length,
        alreadyInProd,
        ...(EXECUTE ? { insertedToProd: inserted } : { wouldInsert: toInsert.length }),
      });
    }

    console.log('\n=== SUMMARY ===');
    console.table(summary);

    if (!EXECUTE) {
      console.log('\nThis was a dry run - no writes to prod. Re-run with --execute to actually migrate.');
    }
  } finally {
    await mongoose.disconnect();
    await prodConn.close();
  }
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
