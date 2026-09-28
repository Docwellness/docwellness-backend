/**
 * Backfills AI-generated main dish photos for recipes that have none, using
 * the same pipeline the dietician app's per-recipe "regenerate image" button
 * calls (utils/recipeImageGenerator.js): Jev picks a photography style +
 * hero ingredient from the recipe's own data, OpenAI renders it, the result
 * is mirrored into Cloudinary and persisted (imageSource: 'ai-generated').
 *
 * Exists because uploading 196+ recipe photos by hand doesn't scale - this
 * unblocks the catalog in one run, while any dietician can still replace an
 * individual recipe's photo later via the existing upload flow or the
 * refresh button (which overwrites imageSource back to 'ai-generated' only
 * if THEY tap AI-regenerate again, never silently).
 *
 * Resumable: only touches recipes with no `image` (or --force). Paced
 * between recipes since both Jev and the OpenAI image call are real,
 * rate-limited external requests - if interrupted, just re-run.
 *
 * Usage:
 *   node scripts/backfill-recipe-images.js                        # dry run - counts only
 *   node scripts/backfill-recipe-images.js --execute               # generate + persist for every recipe missing an image
 *   node scripts/backfill-recipe-images.js --execute --limit=10     # small batch
 *   node scripts/backfill-recipe-images.js --execute --recipe-ids=<id1>,<id2>   # specific recipes, regardless of missing-image status
 *   node scripts/backfill-recipe-images.js --execute --force        # regenerate even for recipes that already have an image
 */

require('dotenv').config();
const mongoose = require('mongoose');
const { generateAndStoreRecipeImage } = require('../utils/recipeImageGenerator');

const EXECUTE = process.argv.includes('--execute');
const FORCE = process.argv.includes('--force');
const limitArg = process.argv.find((a) => a.startsWith('--limit='));
const LIMIT = limitArg ? parseInt(limitArg.split('=')[1], 10) : null;
const idsArg = process.argv.find((a) => a.startsWith('--recipe-ids='));
const RECIPE_IDS = idsArg ? idsArg.split('=')[1].split(',').map((s) => s.trim()).filter(Boolean) : null;
const DELAY_MS = 2000; // conservative pacing across two external APIs (Jev + OpenAI images) per recipe

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  console.log(EXECUTE ? '=== EXECUTING recipe-image backfill ===' : '=== DRY RUN (pass --execute to generate + persist) ===');

  if (!process.env.TYPESAFE_API_KEY) {
    console.error('TYPESAFE_API_KEY is not set - art-direction (Jev) calls will fail.');
    if (EXECUTE) { process.exitCode = 1; return; }
  }
  if (!process.env.OPENAI_API_KEY) {
    console.error('OPENAI_API_KEY is not set - image generation will fail.');
    if (EXECUTE) { process.exitCode = 1; return; }
  }
  if (!process.env.CLOUDINARY_CLOUD_NAME) {
    console.error('CLOUDINARY_CLOUD_NAME is not set - image storage will fail.');
    if (EXECUTE) { process.exitCode = 1; return; }
  }

  console.log('Connecting to MongoDB...');
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected.');

  try {
    const { Recipe } = require('../models');

    let filter;
    if (RECIPE_IDS) {
      filter = { _id: { $in: RECIPE_IDS } };
    } else if (FORCE) {
      filter = {};
    } else {
      filter = { $or: [{ image: { $exists: false } }, { image: null }, { image: '' }] };
    }

    const recipes = await Recipe.find(filter).select('_id dieticianId name image').lean();
    const toProcess = LIMIT ? recipes.slice(0, LIMIT) : recipes;

    console.log(`\n${recipes.length} recipe(s) match${RECIPE_IDS ? ' the given --recipe-ids' : FORCE ? ' (--force: all recipes)' : ' (missing an image)'}.`);
    if (LIMIT) console.log(`Limited to ${toProcess.length} (--limit=${LIMIT}).`);

    if (!EXECUTE) {
      console.log('\nThis was a dry run - no API calls, no DB writes. Re-run with --execute to generate + persist.');
      toProcess.slice(0, 20).forEach((r) => console.log(`  - ${r.name} (${r._id})`));
      if (toProcess.length > 20) console.log(`  ...and ${toProcess.length - 20} more.`);
      return;
    }

    let succeeded = 0;
    let failed = 0;
    for (let i = 0; i < toProcess.length; i++) {
      const recipe = toProcess[i];
      process.stdout.write(`[${i + 1}/${toProcess.length}] "${recipe.name}" (${recipe._id})... `);
      try {
        const result = await generateAndStoreRecipeImage({ recipeId: recipe._id, dieticianId: recipe.dieticianId });
        if (result.ok) {
          succeeded++;
          console.log(`done (style=${result.artDirection.style}, hero=${result.artDirection.heroLabel})`);
        } else {
          failed++;
          console.log(`failed: ${result.message}`);
        }
      } catch (error) {
        failed++;
        console.log(`error: ${error.message}`);
      }
      if (i < toProcess.length - 1) await sleep(DELAY_MS);
    }

    console.log(`\n=== DONE === Succeeded: ${succeeded}, Failed: ${failed}`);
  } catch (error) {
    console.error('Backfill failed:', error);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
    console.log('Disconnected from MongoDB.');
  }
}

main();
