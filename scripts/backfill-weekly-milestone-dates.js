/**
 * CLI runner for utils/backfillWeeklyMilestoneDates.js - see that file for
 * what this corrects and why. Run once after deploying the
 * seedGoalTimeline.js weekly-date fix:
 *   node scripts/backfill-weekly-milestone-dates.js
 */

// Same DNS fix as seed-home-workout-exercises.js - the default system
// resolver on this machine doesn't handle mongodb+srv://'s SRV/TXT lookups.
require('dns').setServers(['8.8.8.8', '1.1.1.1']);

require('dotenv').config();
const mongoose = require('mongoose');
const config = require('../config/environment');
const { backfillWeeklyMilestoneDates } = require('../utils/backfillWeeklyMilestoneDates');

async function run() {
  try {
    console.log('Connecting to MongoDB...');
    await mongoose.connect(config.mongoUri || process.env.MONGODB_URI);
    console.log('Connected.');

    const result = await backfillWeeklyMilestoneDates();
    console.log(
      `Done. Found: ${result.total}, fixed: ${result.fixed}, already correct: ${result.alreadyCorrect}, skipped: ${result.skipped}.`
    );
    if (result.skippedIds.length > 0) {
      console.log('Skipped IDs:', result.skippedIds.join(', '));
    }
    process.exit(0);
  } catch (error) {
    console.error('Backfill failed:', error);
    process.exit(1);
  }
}

run();
