/**
 * Backfills Exercise.secondsPerRep on existing catalog entries created
 * before that field existed, so submitExerciseLog's duration-estimation
 * fallback (see utils/exerciseHelpers.js's estimateDurationMinutes) has a
 * value to work with for every exercise, not just newly-created ones.
 *
 * Runs across ALL dieticians' catalogs (unlike translate-home-workout-
 * exercises.js, which is scoped to one dietician's home-workout tag) -
 * every existing Exercise doc missing secondsPerRep gets one.
 *
 * Reuses the full generateExerciseWithAI call (same one createExercise's
 * AI-preview uses) and takes only the secondsPerRep field from its result -
 * every other field on the existing doc (met, description, the dietician's
 * own edits) is left untouched.
 *
 * Usage:
 *   node scripts/backfill-exercise-seconds-per-rep.js            # dry run
 *   node scripts/backfill-exercise-seconds-per-rep.js --execute   # write
 */

// Same DNS fix as seed-home-workout-exercises.js - the default system
// resolver on this machine doesn't handle mongodb+srv://'s SRV/TXT lookups.
require('dns').setServers(['8.8.8.8', '1.1.1.1']);

require('dotenv').config();
const mongoose = require('mongoose');
const { generateExerciseWithAI } = require('../utils/openaiClient');

const EXECUTE = process.argv.includes('--execute');

async function main() {
  console.log(EXECUTE ? '=== EXECUTING secondsPerRep backfill ===' : '=== DRY RUN (pass --execute to write) ===');

  console.log('Connecting to MongoDB...');
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected.');

  try {
    const { Exercise } = require('../models');

    const exercises = await Exercise.find({ secondsPerRep: null });
    console.log(`\nFound ${exercises.length} exercise(s) missing secondsPerRep.`);

    console.log(`\n=== PLAN: estimate secondsPerRep for ${exercises.length} exercise(s) ===`);
    exercises.forEach((e, i) => console.log(`${i + 1}. "${e.name}" (${e.category})`));

    if (!EXECUTE) {
      console.log('\nThis was a dry run - no AI calls, no DB writes. Re-run with --execute to backfill these.');
      return;
    }

    let updated = 0;
    let failed = 0;
    for (const ex of exercises) {
      try {
        console.log(`\nEstimating: "${ex.name}"...`);
        const generated = await generateExerciseWithAI({ name: ex.name, category: ex.category, languages: ['English'] });

        if (typeof generated.secondsPerRep !== 'number') {
          console.log(`  ✗ No secondsPerRep returned for "${ex.name}" - skipping save`);
          failed++;
          continue;
        }

        ex.secondsPerRep = generated.secondsPerRep;
        await ex.save();

        updated++;
        console.log(`  ✓ "${ex.name}" -> secondsPerRep: ${generated.secondsPerRep}`);
      } catch (err) {
        failed++;
        console.error(`  ✗ FAILED "${ex.name}": ${err.message}`);
      }
    }

    console.log(`\nDone. Updated ${updated} exercise(s), ${failed} failure(s).`);
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
