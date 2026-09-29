/**
 * Writes the AI-generated recipe photos (batch 1: 100 recipes, generated via
 * Canva + Jev art-direction, ingredient-constrained prompts) from
 * scripts/data/recipe-image-migration-batch1-100.jsonl into whichever
 * MongoDB this script is run against.
 *
 * Meant to be run directly in the target environment (e.g. a Coolify
 * terminal into the docwellness-backend container for prod, or wherever
 * dev's MONGODB_URI already points) - same convention as
 * apply-recipe-translation-fixes-prod.js. Uses config/database.js's
 * connectDB() rather than a bare mongoose.connect(uri) so prod's private-CA
 * TLS setup (MONGODB_TLS_CA_BASE64) is handled automatically; dev's Atlas
 * mongodb+srv:// URI needs no such setup and connectDB() degrades
 * gracefully to plain options there. Run this script once per target
 * database - once against dev, once against prod/main - to push the same
 * batch everywhere.
 *
 * Each row in the manifest is one recipe: { recipeId, dieticianId, imageUrl,
 * imageSource, style, heroLabel, prompt }. Only `image` and `imageSource`
 * are written; style/heroLabel/prompt are kept in the manifest purely as a
 * record of how each photo was generated, not written to the DB.
 *
 * Idempotent: a recipe whose `image` already equals the manifest's imageUrl
 * is skipped ("already applied"). Safe to re-run, safe to run against dev
 * and prod independently - each only touches recipes it can find with a
 * matching recipeId AND dieticianId (a recipeId absent from a given
 * database, e.g. dev vs prod having diverged recipe sets, is skipped with a
 * warning rather than throwing).
 *
 * Usage (run from this repo's root, so ../models/Recipe resolves):
 *   node scripts/migrate-recipe-images-batch1.js                    # dry run (prints diffs, writes nothing)
 *   node scripts/migrate-recipe-images-batch1.js --execute          # write
 *   node scripts/migrate-recipe-images-batch1.js --only=<recipeId> [--execute]   # one recipe
 *
 * ALWAYS run without --execute first and read the output before adding --execute.
 */
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const connectDB = require('../config/database');

const EXECUTE = process.argv.includes('--execute');
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) || '').slice('--only='.length) || null;

const MANIFEST_PATH = path.join(__dirname, 'data', 'recipe-image-migration-batch1-100.jsonl');

function loadManifest() {
  const lines = fs.readFileSync(MANIFEST_PATH, 'utf8').trim().split('\n');
  return lines.map((l) => JSON.parse(l)).filter((e) => !ONLY || e.recipeId === ONLY);
}

async function main() {
  console.log(EXECUTE ? '=== EXECUTING ===' : '=== DRY RUN (pass --execute to write) ===');
  console.log(`DB: ${(process.env.MONGODB_URI || '').replace(/\/\/[^@]+@/, '//<redacted>@')}`);
  await connectDB();
  const Recipe = require('../models/Recipe');

  const entries = loadManifest();
  console.log(`Manifest entries to process: ${entries.length}\n`);

  let written = 0;
  let alreadyApplied = 0;
  let notFound = 0;
  let ownerMismatch = 0;
  let failed = 0;

  for (const entry of entries) {
    try {
      const recipe = await Recipe.findById(entry.recipeId).select('name dieticianId image imageSource').lean();
      if (!recipe) {
        console.log(`!! ${entry.recipeId}: not found in this database - skipped`);
        notFound++;
        continue;
      }
      if (String(recipe.dieticianId) !== String(entry.dieticianId)) {
        console.log(`!! ${entry.recipeId} (${recipe.name}): dieticianId mismatch (db=${recipe.dieticianId}, manifest=${entry.dieticianId}) - skipped`);
        ownerMismatch++;
        continue;
      }
      if (recipe.image === entry.imageUrl && recipe.imageSource === entry.imageSource) {
        console.log(`   ${recipe.name}: already applied - skipped`);
        alreadyApplied++;
        continue;
      }

      console.log(`### ${recipe.name} (${entry.recipeId})`);
      console.log(`  image\n      - ${recipe.image || '(none)'}\n      + ${entry.imageUrl}`);
      if (recipe.imageSource !== entry.imageSource) {
        console.log(`  imageSource\n      - ${recipe.imageSource || '(none)'}\n      + ${entry.imageSource}`);
      }

      if (EXECUTE) {
        const res = await Recipe.updateOne(
          { _id: entry.recipeId },
          { $set: { image: entry.imageUrl, imageSource: entry.imageSource } },
        );
        console.log(`  -> written (matched ${res.matchedCount}, modified ${res.modifiedCount})`);
      }
      written++;
    } catch (err) {
      console.log(`!! ${entry.recipeId}: unexpected error, skipped: ${err.message}`);
      failed++;
    }
  }

  console.log('\n--- summary ---');
  console.log(`Recipes ${EXECUTE ? 'updated' : 'to update'}: ${written}`);
  console.log(`Already applied (no-op): ${alreadyApplied}`);
  console.log(`Not found in this DB: ${notFound}`);
  console.log(`Owner mismatch: ${ownerMismatch}`);
  console.log(`Errors: ${failed}`);
  await mongoose.disconnect();
  if (notFound || ownerMismatch || failed) process.exitCode = 1;
}

main().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect();
  process.exit(1);
});
