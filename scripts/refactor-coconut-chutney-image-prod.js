/**
 * Replaces the main image of the "Coconut Chutney" recipe, which showed an
 * unrelated app-mockup screenshot, with a freshly generated Canva photo.
 *
 * Meant to be run directly in the production environment (e.g. a Coolify
 * terminal into the docwellness-backend container), where MONGODB_URI is
 * already the real prod connection string - same convention as
 * apply-recipe-translation-fixes-prod.js / migrate-recipe-images-batch1.js.
 * Uses config/database.js's connectDB() so prod's private-CA TLS setup is
 * handled.
 *
 * The image is passed with --image=, either:
 *   - a local file path (the full-size JPG/PNG downloaded from Canva) - it is
 *     converted to WebP (quality auto) by Cloudinary during upload, into the
 *     recipe owner's docwellness/<dieticianId>/recipes/main folder, so the
 *     stored URL ends in .webp (needs CLOUDINARY_* in the environment), or
 *   - an https URL that is already hosted (written as-is, nothing uploaded;
 *     a warning is printed if it does not look like a WebP URL).
 *
 * Writes only `image` and `imageSource: 'ai-generated'` (same as the batch
 * image migrations). Idempotent: a recipe whose image already equals the final
 * URL is skipped. Matches recipes by exact name (case-insensitive); if more
 * than one matches, it lists them and exits - re-run with --id=<recipeId>.
 *
 * Usage (from the repo root):
 *   node scripts/refactor-coconut-chutney-image-prod.js --image=./coconut-chutney.jpg            # dry run
 *   node scripts/refactor-coconut-chutney-image-prod.js --image=./coconut-chutney.jpg --execute  # upload as WebP + write
 *   node scripts/refactor-coconut-chutney-image-prod.js --image=<https url> --id=<recipeId> [--execute]
 *
 * ALWAYS run without --execute first and read the output before adding --execute.
 */
require('dotenv').config({ quiet: true });
const fs = require('fs');
const mongoose = require('mongoose');
const connectDB = require('../config/database');

const EXECUTE = process.argv.includes('--execute');
const arg = (name) => (process.argv.find((a) => a.startsWith(`--${name}=`)) || '').slice(name.length + 3) || null;
const IMAGE = arg('image');
const ID = arg('id');
const NAME = arg('name') || 'Coconut Chutney';
const IMAGE_SOURCE = 'ai-generated';
// Same WebP convention as the other recipe images (Cloudinary quality auto),
// stored as a real .webp asset so the URL ends in .webp.
const WEBP_UPLOAD_OPTIONS = { format: 'webp', transformation: [{ quality: 'auto' }] };
const looksLikeWebp = (url) => /\.webp(\?|#|$)/i.test(url) || url.includes('/upload/f_webp');

async function main() {
  if (!IMAGE) {
    console.error('Missing --image=<local file path | https url>');
    process.exit(1);
  }
  const isUrl = /^https?:\/\//i.test(IMAGE);
  if (!isUrl && !fs.existsSync(IMAGE)) {
    console.error(`Image file not found: ${IMAGE}`);
    process.exit(1);
  }
  if (!isUrl && !/\.(jpe?g|png)$/i.test(IMAGE)) {
    console.error(`Unsupported image type for ${IMAGE} - pass a JPG or PNG (it is converted to WebP on upload).`);
    process.exit(1);
  }
  if (isUrl && !looksLikeWebp(IMAGE)) {
    console.log(`WARNING: --image is an https URL that does not look like WebP (${IMAGE}). It will be stored as-is.`);
  }

  console.log(EXECUTE ? '=== EXECUTING ===' : '=== DRY RUN (pass --execute to write) ===');
  console.log(`DB: ${(process.env.MONGODB_URI || '').replace(/\/\/[^@]+@/, '//<redacted>@')}`);
  await connectDB();
  const Recipe = require('../models/Recipe');

  const escaped = NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const filter = ID ? { _id: ID } : { name: new RegExp(`^${escaped}$`, 'i') };
  const matches = await Recipe.find(filter).select('name dieticianId image imageSource').lean();

  if (matches.length === 0) {
    console.log(`!! No recipe found for ${ID ? `id ${ID}` : `name "${NAME}"`} in this database.`);
    process.exitCode = 1;
    return;
  }
  if (matches.length > 1) {
    console.log(`!! ${matches.length} recipes match "${NAME}" - re-run with --id=<recipeId>:`);
    matches.forEach((r) => console.log(`   ${r._id}  ${r.name}  (dietician ${r.dieticianId})  ${r.image || '(no image)'}`));
    process.exitCode = 1;
    return;
  }

  const recipe = matches[0];
  console.log(`### ${recipe.name} (${recipe._id})`);
  console.log(`  current image: ${recipe.image || '(none)'}  [source: ${recipe.imageSource || '(none)'}]`);

  let imageUrl = IMAGE;
  if (!isUrl) {
    // Already applied by a previous run: skip the upload so re-runs don't create duplicate assets.
    if (recipe.imageSource === IMAGE_SOURCE && looksLikeWebp(recipe.image || '') && recipe.image.includes('/upload/')) {
      console.log('  already applied (WebP image from a previous upload) - skipped upload');
      return;
    }
    if (!EXECUTE) {
      console.log(`  would upload ${IMAGE} to Cloudinary as WebP, then set image + imageSource=${IMAGE_SOURCE}`);
      return;
    }
    if (!(process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET)) {
      console.error('Missing CLOUDINARY_CLOUD_NAME / CLOUDINARY_API_KEY / CLOUDINARY_API_SECRET.');
      process.exitCode = 1;
      return;
    }
    const cloudinary = require('../config/cloudinary');
    const { cloudinaryUserFolder } = require('../utils/cloudinaryFolder');
    const folder = cloudinaryUserFolder(recipe.dieticianId, 'recipes/main');
    const res = await cloudinary.uploader.upload(IMAGE, { folder, ...WEBP_UPLOAD_OPTIONS });
    imageUrl = res.secure_url || res.url;
    console.log(`  uploaded -> ${imageUrl}`);
    if (!looksLikeWebp(imageUrl)) {
      console.log(`  WARNING: uploaded URL does not end in .webp (format=${res.format}) - check before relying on it.`);
    }
  }

  if (recipe.image === imageUrl && recipe.imageSource === IMAGE_SOURCE) {
    console.log('  already applied - skipped');
    return;
  }
  console.log(`  image\n      - ${recipe.image || '(none)'}\n      + ${imageUrl}`);

  if (EXECUTE) {
    const res = await Recipe.updateOne({ _id: recipe._id }, { $set: { image: imageUrl, imageSource: IMAGE_SOURCE } });
    console.log(`  -> written (matched ${res.matchedCount}, modified ${res.modifiedCount})`);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
