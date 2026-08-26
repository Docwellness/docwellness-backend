/**
 * Applies the pre-generated cooking steps in
 * scripts/data/hand-authored-batch-1-cooking-steps.json to matching Recipe
 * documents that are still missing instructions - no AI calls at runtime.
 *
 * Exists because scripts/backfill-hand-authored-recipe-steps.js's AI calls
 * (98 sequential real OpenAI requests, several minutes end to end) are too
 * slow to run safely inside Coolify's Scheduled Task/one-off job runner -
 * no Terminal tab available in this deployment, no streaming output (shows
 * "Waiting for task output..." until the process exits), and an unknown
 * execution timeout. The steps were instead generated once, locally,
 * against dev (already verified correct - see e.g. "Baked Besan Pakora"
 * getting real baked-fritter steps, not the generic placeholder that
 * prompted this whole fix) and exported to that JSON file. This script
 * only ever does fast, plain DB writes - matches by (dieticianId, name),
 * skips anything not currently missing instructions - so a full run
 * against prod's 99 recipes should complete in well under a second per
 * recipe, safely inside any job timeout.
 *
 * Connects via connectDB() (config/database.js), not a raw mongoose.connect()
 * - required for prod's self-hosted Mongo's custom TLS CA. Looks the
 * dietician up by _id, not email - see scripts/lookup-dietician-id.js's own
 * comment: prod's dietician User document mirrors dev's by _id but its
 * stored email can differ (confirmed: dev has tejasvini@docwellness.fit,
 * prod's real login is dr.tejasvini.pawar@gmail.com).
 *
 * Idempotent: re-running only touches recipes still missing instructions.
 *
 * Usage:
 *   node scripts/apply-precomputed-cooking-steps.js            # dry run
 *   node scripts/apply-precomputed-cooking-steps.js --execute   # write
 */
require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/database');
const path = require('path');

const EXECUTE = process.argv.includes('--execute');
const DIETICIAN_ID = '6a5e0c3619fa51068811c304';
const DATA_FILE = path.join(__dirname, 'data', 'hand-authored-batch-1-cooking-steps.json');

async function main() {
  console.log(EXECUTE ? '=== EXECUTING precomputed cooking-steps apply ===' : '=== DRY RUN (pass --execute to write) ===');
  const precomputed = require(DATA_FILE);
  console.log(`Loaded ${precomputed.length} precomputed recipe(s) from ${DATA_FILE}.`);

  console.log('Connecting to MongoDB...');
  await connectDB();
  console.log('Connected.');

  try {
    const { User, Recipe } = require('../models');
    const { syncV1FromRecipe } = require('../services/recipeVersioningService');

    const dietician = await User.findById(DIETICIAN_ID);
    if (!dietician) throw new Error(`Dietician not found: ${DIETICIAN_ID}`);
    console.log(`Target dietician: ${dietician.profile?.fullName || dietician.email} (${dietician._id})\n`);

    let updated = 0;
    let skipped = 0;
    let missing = 0;
    let failed = 0;

    for (const entry of precomputed) {
      const recipe = await Recipe.findOne({ dieticianId: dietician._id, name: entry.name });
      if (!recipe) {
        console.log(`MISSING (no matching recipe on this DB): "${entry.name}"`);
        missing++;
        continue;
      }
      if ((recipe.instructions || []).length > 0) {
        console.log(`SKIP (already has steps): "${entry.name}"`);
        skipped++;
        continue;
      }

      console.log(`"${entry.name}" [${entry.servingTime}]`);
      entry.instructions.forEach((s, i) => console.log(`  ${i + 1}. ${s}`));

      if (EXECUTE) {
        try {
          recipe.instructions = entry.instructions;
          await recipe.save();
          await syncV1FromRecipe(recipe);
          console.log('  saved.\n');
          updated++;
        } catch (err) {
          console.error(`  FAILED to save "${entry.name}": ${err.message}\n`);
          failed++;
        }
      } else {
        console.log('');
      }
    }

    console.log(
      `\n=== ${EXECUTE ? 'DONE' : 'DRY RUN DONE'} === total=${precomputed.length} updated=${updated} skipped=${skipped} missing=${missing} failed=${failed}`
    );
  } finally {
    await mongoose.disconnect();
    console.log('Disconnected from MongoDB.');
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
