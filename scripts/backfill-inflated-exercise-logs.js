/**
 * CLI runner for utils/backfillInflatedExerciseLogs.js - see that file for
 * what this corrects and why. Dry run by default (prints what would change):
 *   node scripts/backfill-inflated-exercise-logs.js
 * Apply the correction:
 *   node scripts/backfill-inflated-exercise-logs.js --execute
 *
 * Connects via connectDB() (config/database.js), not a raw mongoose.connect()
 * - required for prod's self-hosted Mongo's custom TLS CA
 * (MONGODB_TLS_CA_BASE64), same as the other prod scripts.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/database');
const { backfillInflatedExerciseLogs } = require('../utils/backfillInflatedExerciseLogs');

const EXECUTE = process.argv.includes('--execute') || process.argv.includes('--apply');

async function run() {
  try {
    console.log(EXECUTE ? '=== EXECUTING exercise log backfill ===' : '=== DRY RUN (pass --execute to write) ===');
    await connectDB();
    const result = await backfillInflatedExerciseLogs({ apply: EXECUTE });
    console.log(
      `${EXECUTE ? 'APPLIED' : 'DRY RUN'}: ${result.entriesAffected} inflated entr${result.entriesAffected === 1 ? 'y' : 'ies'}` +
        (EXECUTE ? ` across ${result.logsTouched} log(s) corrected.` : ' would be corrected (re-run with --execute).')
    );
    for (const c of result.changes) {
      console.log(
        `  log ${c.logId} ${new Date(c.date).toISOString().slice(0, 10)}: ${c.durationFrom} -> ${c.durationTo} min, ` +
          `${c.caloriesFrom} -> ${c.caloriesTo} kcal (sets=${c.sets})`
      );
    }
    await mongoose.disconnect();
    process.exit(0);
  } catch (error) {
    console.error('Backfill failed:', error);
    process.exit(1);
  }
}

run();
