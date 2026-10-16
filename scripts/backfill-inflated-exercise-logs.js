/**
 * CLI runner for utils/backfillInflatedExerciseLogs.js - see that file for
 * what this corrects and why. Dry run by default (prints what would change):
 *   node scripts/backfill-inflated-exercise-logs.js
 * Apply the correction:
 *   node scripts/backfill-inflated-exercise-logs.js --apply
 */
require('dns').setServers(['8.8.8.8', '1.1.1.1']);

require('dotenv').config();
const mongoose = require('mongoose');
const config = require('../config/environment');
const { backfillInflatedExerciseLogs } = require('../utils/backfillInflatedExerciseLogs');

async function run() {
  const apply = process.argv.includes('--apply');
  try {
    await mongoose.connect(config.mongoUri || process.env.MONGODB_URI);
    const result = await backfillInflatedExerciseLogs({ apply });
    console.log(
      `${apply ? 'APPLIED' : 'DRY RUN'}: ${result.entriesAffected} inflated entr${result.entriesAffected === 1 ? 'y' : 'ies'}` +
        (apply ? ` across ${result.logsTouched} log(s) corrected.` : ' would be corrected (re-run with --apply).')
    );
    for (const c of result.changes) {
      console.log(
        `  log ${c.logId} ${new Date(c.date).toISOString().slice(0, 10)}: ${c.durationFrom} -> ${c.durationTo} min, ` +
          `${c.caloriesFrom} -> ${c.caloriesTo} kcal (sets=${c.sets})`
      );
    }
    process.exit(0);
  } catch (error) {
    console.error('Backfill failed:', error);
    process.exit(1);
  }
}

run();
