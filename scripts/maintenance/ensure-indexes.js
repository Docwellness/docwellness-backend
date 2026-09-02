#!/usr/bin/env node
// Creates/syncs every Mongoose model's indexes against the actual
// database. Model.syncIndexes() creates any index declared in the schema
// that doesn't exist yet in the collection, AND drops any index that
// exists in the DB but is no longer declared in the schema - safe to run
// repeatedly (idempotent), and never touches document data, only index
// metadata. Run this after deploying a change that adds/removes a
// schema-level .index() call (see AI_EXECUTION_PLAN.md Phase 3, P3-02).
//
// Usage:
//   node scripts/maintenance/ensure-indexes.js
//
// Exit code is 0 only if every model synced successfully. A per-model
// failure (most commonly: trying to add a `unique` index where the
// collection already has duplicate values for that field) does not stop
// the other models from being processed - the summary at the end lists
// exactly which ones need attention.

require('dotenv').config();
const mongoose = require('mongoose');
const config = require('../../config/environment');
// Reuse the app's own connect (retry + private-CA TLS handling) rather than
// a raw mongoose.connect(): prod's self-hosted Mongo is reached over TLS
// with a private CA (MONGODB_TLS_CA_BASE64 -> tls/tlsCAFile in
// config/database.js). A bare connect here skips that and dies with a
// misleading "self-signed certificate in certificate chain".
const connectDB = require('../../config/database');

// Requiring these registers every model on `mongoose` as a side effect,
// regardless of whether it's re-exported by models/index.js or
// chat/models/index.js - so this script iterates whatever models actually
// exist without needing to hardcode their names, and stays correct as
// models are added/removed later.
require('../../models');
require('../../chat/models');

async function main() {
  if (!config.mongodbUri) {
    console.error('MONGODB_URI is not set - see .env.example. Aborting.');
    process.exit(1);
  }

  console.log('Connecting to MongoDB...');
  await connectDB();
  console.log('Connected.\n');

  const modelNames = mongoose.modelNames().sort();
  console.log(`Syncing indexes for ${modelNames.length} model(s): ${modelNames.join(', ')}\n`);

  const results = [];
  for (const name of modelNames) {
    const model = mongoose.model(name);
    try {
      // Returns the names of any indexes that were DROPPED (present in the
      // DB but no longer declared in the schema) - newly-created indexes
      // aren't listed individually, just applied.
      const dropped = await model.syncIndexes();
      results.push({ name, ok: true, dropped });
      console.log(
        dropped.length > 0
          ? `✓ ${name} - synced (dropped stale index(es): ${dropped.join(', ')})`
          : `✓ ${name} - synced (already in sync)`
      );
    } catch (err) {
      results.push({ name, ok: false, error: err.message });
      console.error(`✗ ${name} - FAILED: ${err.message}`);
    }
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} model(s) synced successfully.`);
  if (failed.length > 0) {
    console.error(
      `${failed.length} model(s) failed - see above. A failure adding a unique index usually means the collection already has duplicate values for that field; find and resolve the duplicates before re-running.`
    );
  }

  await mongoose.disconnect();
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('ensure-indexes failed unexpectedly:', err);
  process.exit(1);
});
