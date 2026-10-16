/**
 * CLI runner for utils/backfillRepsExerciseLogs.js - see that file for what
 * this corrects and why. Dry run by default (prints what would change):
 *   node scripts/backfill-reps-exercise-logs.js
 * Apply the correction:
 *   node scripts/backfill-reps-exercise-logs.js --execute
 *
 * Connects via connectDB() (config/database.js), not a raw mongoose.connect()
 * - required for prod's self-hosted Mongo's custom TLS CA
 * (MONGODB_TLS_CA_BASE64), same as the other prod scripts.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/database');
const { backfillRepsExerciseLogs } = require('../utils/backfillRepsExerciseLogs');

const EXECUTE = process.argv.includes('--execute');

async function run() {
  try {
    console.log(EXECUTE ? '=== EXECUTING reps-exercise log backfill ===' : '=== DRY RUN (pass --execute to write) ===');
    await connectDB();
    const result = await backfillRepsExerciseLogs({ apply: EXECUTE });
    console.log(
      `${EXECUTE ? 'APPLIED' : 'DRY RUN'}: ${result.entriesAffected} entr${result.entriesAffected === 1 ? 'y' : 'ies'}` +
        (EXECUTE ? ` across ${result.logsTouched} log(s) corrected.` : ' would be corrected (re-run with --execute).')
    );
    for (const c of result.changes) {
      console.log(
        `  log ${c.logId} ${new Date(c.date).toISOString().slice(0, 10)} ${c.exercise} (${c.sets}x${c.reps}): ` +
          `${c.durationFrom} -> ${c.durationTo} min, ${c.caloriesFrom} -> ${c.caloriesTo} kcal`
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
