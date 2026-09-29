/**
 * Rewrites the 100 batch-1 AI-generated recipe photos' `image` URL to
 * request WebP delivery from Cloudinary, instead of re-encoding and
 * re-uploading any bytes.
 *
 * Cloudinary transforms and caches on the fly when a `f_webp` segment is
 * added right after `/upload/` in the URL path - the original JPG/WebP
 * asset already in storage is untouched, only the DB's `image` field
 * changes to a URL that asks for the WebP variant. Verified directly
 * (curl) before writing this script: adding `f_webp,q_auto/` to a stored
 * URL flips the response `Content-Type` from `image/jpeg` to `image/webp`
 * and roughly halves `Content-Length` (159KB -> 76KB on the sample
 * checked) - a real, immediate size win with zero re-upload cost.
 *
 * `f_webp` (not `f_auto`) is used deliberately: `f_auto` content-negotiates
 * off the request's `Accept` header, which real browsers send correctly
 * but Flutter's `Image.network` (`dart:io` HttpClient) does not reliably
 * send - so `f_auto` risks silently falling back to JPEG in exactly the
 * apps where this matters most (the website's `next/image` already
 * re-encodes to the best format on its own regardless of source format,
 * per the ai-generated-recipe-images openspec discussion). `f_webp` forces
 * WebP unconditionally, verified with a plain `curl` (no special `Accept`
 * header) still returning `image/webp`.
 *
 * Meant to be run directly in the target environment (e.g. a Coolify
 * terminal into the docwellness-backend container for prod) - same
 * convention as migrate-recipe-images-batch1.js / apply-recipe-translation-
 * fixes-prod.js. Uses config/database.js's connectDB() for prod's
 * private-CA TLS setup.
 *
 * Idempotent: a URL that already contains an `f_` transformation segment
 * (i.e. this script - or migrate-recipe-images-batch1.js re-run after this
 * one - already touched it) is left alone. Safe to re-run, safe to run
 * against dev and prod independently.
 *
 * Usage (run from this repo's root, so ../models/Recipe resolves):
 *   node scripts/convert-recipe-images-to-webp.js                    # dry run (prints diffs, writes nothing)
 *   node scripts/convert-recipe-images-to-webp.js --execute          # write
 *   node scripts/convert-recipe-images-to-webp.js --only=<recipeId> [--execute]   # one recipe
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

/** Inserts `f_webp,q_auto/` right after `/upload/` in a Cloudinary delivery URL. */
function toWebpUrl(url) {
  return url.replace('/upload/', '/upload/f_webp,q_auto/');
}

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
  let alreadyWebp = 0;
  let notFound = 0;
  let ownerMismatch = 0;
  let unexpectedUrl = 0;
  let failed = 0;

  for (const entry of entries) {
    try {
      const recipe = await Recipe.findById(entry.recipeId).select('name dieticianId image').lean();
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
      if (!recipe.image || !recipe.image.includes('/upload/')) {
        console.log(`!! ${entry.recipeId} (${recipe.name}): image URL doesn't look like a Cloudinary delivery URL (${recipe.image || '(none)'}) - skipped`);
        unexpectedUrl++;
        continue;
      }
      if (recipe.image.includes('/upload/f_')) {
        console.log(`   ${recipe.name}: already has a format transform - skipped`);
        alreadyWebp++;
        continue;
      }

      const newUrl = toWebpUrl(recipe.image);
      console.log(`### ${recipe.name} (${entry.recipeId})`);
      console.log(`  image\n      - ${recipe.image}\n      + ${newUrl}`);

      if (EXECUTE) {
        const res = await Recipe.updateOne({ _id: entry.recipeId }, { $set: { image: newUrl } });
        console.log(`  -> written (matched ${res.matchedCount}, modified ${res.modifiedCount})`);
      }
      written++;
    } catch (err) {
      console.log(`!! ${entry.recipeId}: unexpected error, skipped: ${err.message}`);
      failed++;
    }
  }

  console.log('\n--- summary ---');
  console.log(`Recipes ${EXECUTE ? 'converted' : 'to convert'}: ${written}`);
  console.log(`Already WebP/transformed (no-op): ${alreadyWebp}`);
  console.log(`Not found in this DB: ${notFound}`);
  console.log(`Owner mismatch: ${ownerMismatch}`);
  console.log(`Unexpected image URL shape: ${unexpectedUrl}`);
  console.log(`Errors: ${failed}`);
  await mongoose.disconnect();
  if (notFound || ownerMismatch || unexpectedUrl || failed) process.exitCode = 1;
}

main().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect();
  process.exit(1);
});
