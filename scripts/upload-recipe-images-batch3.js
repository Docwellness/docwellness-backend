/**
 * Uploads the locally staged AI-generated recipe photos (batch 3) to
 * Cloudinary and writes the migration manifest that
 * scripts/migrate-recipe-images-batch1.js consumes.
 *
 * Input:  scripts/data/recipe-image-migration-batch3-local.jsonl
 *         one row per recipe: { recipeId, dieticianId, name, file, canvaMediaId }
 *         with the JPGs in scripts/data/recipe-images-batch3/.
 * Output: scripts/data/recipe-image-migration-batch3-uploaded.jsonl
 *         { recipeId, dieticianId, imageUrl, imageSource: 'ai-generated', name, canvaMediaId }
 *
 * Files land in the same Cloudinary folder the app's recipe-image upload uses
 * (docwellness/<dieticianId>/recipes/main), so they sit alongside the
 * batch 1/2 images. Needs CLOUDINARY_CLOUD_NAME / CLOUDINARY_API_KEY /
 * CLOUDINARY_API_SECRET in the environment (.env is loaded).
 *
 * Idempotent: a recipeId already present in the output file is skipped, so a
 * re-run after a partial failure only uploads what is missing and never
 * creates duplicate Cloudinary assets.
 *
 * Usage (from the repo root):
 *   node scripts/upload-recipe-images-batch3.js             # dry run (lists what would upload)
 *   node scripts/upload-recipe-images-batch3.js --execute   # upload + write manifest
 *   node scripts/upload-recipe-images-batch3.js --only=<recipeId> [--execute]
 *
 * Then apply to a database (dry run first):
 *   node scripts/migrate-recipe-images-batch1.js --manifest=recipe-image-migration-batch3-uploaded.jsonl
 */
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const cloudinary = require('../config/cloudinary');
const { cloudinaryUserFolder } = require('../utils/cloudinaryFolder');

const EXECUTE = process.argv.includes('--execute');
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) || '').slice('--only='.length) || null;

const DATA_DIR = path.join(__dirname, 'data');
const IMAGE_DIR = path.join(DATA_DIR, 'recipe-images-batch3');
const INPUT_PATH = path.join(DATA_DIR, 'recipe-image-migration-batch3-local.jsonl');
const OUTPUT_PATH = path.join(DATA_DIR, 'recipe-image-migration-batch3-uploaded.jsonl');

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

async function main() {
  console.log(EXECUTE ? '=== EXECUTING ===' : '=== DRY RUN (pass --execute to upload) ===');

  if (EXECUTE && !(process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET)) {
    console.error('Missing CLOUDINARY_CLOUD_NAME / CLOUDINARY_API_KEY / CLOUDINARY_API_SECRET.');
    process.exit(1);
  }

  const entries = readJsonl(INPUT_PATH).filter((e) => !ONLY || e.recipeId === ONLY);
  const done = new Set(readJsonl(OUTPUT_PATH).map((e) => e.recipeId));
  console.log(`Local entries: ${entries.length}, already uploaded: ${done.size}\n`);

  let uploaded = 0;
  let skipped = 0;
  let failed = 0;

  for (const entry of entries) {
    const label = `${entry.name} (${entry.recipeId})`;
    if (done.has(entry.recipeId)) {
      console.log(`   ${label}: already uploaded - skipped`);
      skipped++;
      continue;
    }
    const filePath = path.join(IMAGE_DIR, path.basename(entry.file || ''));
    if (!entry.file || !fs.existsSync(filePath)) {
      console.log(`!! ${label}: image file missing (${entry.file}) - skipped`);
      failed++;
      continue;
    }
    const folder = cloudinaryUserFolder(entry.dieticianId, 'recipes/main');
    if (!EXECUTE) {
      console.log(`### ${label}\n  ${entry.file} -> ${folder}`);
      uploaded++;
      continue;
    }

    try {
      const res = await cloudinary.uploader.upload(filePath, { folder });
      const imageUrl = res.secure_url || res.url;
      const row = {
        recipeId: entry.recipeId,
        dieticianId: entry.dieticianId,
        imageUrl,
        imageSource: 'ai-generated',
        name: entry.name,
        canvaMediaId: entry.canvaMediaId,
      };
      // Append per upload so a crash mid-run never loses URLs already created.
      fs.appendFileSync(OUTPUT_PATH, `${JSON.stringify(row)}\n`);
      console.log(`### ${label}\n  -> ${imageUrl}`);
      uploaded++;
    } catch (err) {
      console.log(`!! ${label}: upload failed: ${err.message}`);
      failed++;
    }
  }

  console.log('\n--- summary ---');
  console.log(`${EXECUTE ? 'Uploaded' : 'Would upload'}: ${uploaded}`);
  console.log(`Already uploaded (skipped): ${skipped}`);
  console.log(`Errors: ${failed}`);
  if (failed) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
