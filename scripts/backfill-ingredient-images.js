/**
 * Two things, in order:
 *
 * 1. SEED the shared per-dietician Ingredient library (utils/ingredientLibrary.js)
 *    from images that already exist on embedded Recipe.ingredients - the
 *    original run of this script (before the shared library existed) fetched
 *    every occurrence independently, so e.g. "Onion" already has 41 different
 *    Cloudinary images sitting on 41 different recipes with no shared record
 *    tying them together. This picks the first-seen image per distinct
 *    (dietician, ingredient name) as the canonical shared one - which
 *    specific one doesn't matter, they're all valid photos of the same
 *    ingredient - so future fetches for that name can reuse it instead of
 *    hitting Pexels again.
 * 2. FETCH images for any ingredient that still has none, reusing the shared
 *    library whenever possible (utils/ingredientLibrary.js's
 *    getOrCreateIngredientImage with forceRefresh:false) rather than always
 *    hitting Pexels - most fetches after the first occurrence of a common
 *    name (Salt, Onion, Tomato...) resolve instantly with no API call.
 *
 * Paced to stay under Pexels' free-tier rate limit (200 requests/hour) and
 * resumable: re-running skips any ingredient that already has an image, so
 * an interrupted run can just be started again.
 *
 * Usage:
 *   node scripts/backfill-ingredient-images.js            # dry run - counts only
 *   node scripts/backfill-ingredient-images.js --execute  # seed + fetch + persist
 *   node scripts/backfill-ingredient-images.js --execute --limit=5   # small test batch (fetch step only)
 */

require('dotenv').config();
const mongoose = require('mongoose');
const { getOrCreateIngredientImage, normalize } = require('../utils/ingredientLibrary');

const EXECUTE = process.argv.includes('--execute');
const limitArg = process.argv.find((a) => a.startsWith('--limit='));
const LIMIT = limitArg ? parseInt(limitArg.split('=')[1], 10) : null;
const DELAY_MS = 350; // ~170 req/hour, under Pexels' 200/hour free-tier cap

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  console.log(EXECUTE ? '=== EXECUTING ingredient-image backfill ===' : '=== DRY RUN (pass --execute to seed + fetch + persist) ===');
  if (!process.env.PEXELS_API_KEY) {
    console.error('PEXELS_API_KEY is not set in .env - add it before running with --execute.');
    if (EXECUTE) {
      process.exitCode = 1;
      return;
    }
  }

  console.log('Connecting to MongoDB...');
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected.');

  try {
    const { Recipe, Ingredient } = require('../models');

    const recipes = await Recipe.find({}).select('_id dieticianId name ingredients').lean();

    // --- Step 1: seed the shared library from already-imaged ingredients ---
    const seedCandidates = new Map(); // `${dieticianId}|${normalizedName}` -> {dieticianId, name, image, category}
    const missingJobs = [];
    for (const recipe of recipes) {
      (recipe.ingredients || []).forEach((ing, index) => {
        if (ing.image && ing.image.trim()) {
          const key = `${recipe.dieticianId}|${normalize(ing.name)}`;
          if (!seedCandidates.has(key)) {
            seedCandidates.set(key, {
              dieticianId: recipe.dieticianId,
              name: ing.name,
              image: ing.image,
              category: ing.category,
            });
          }
        } else {
          missingJobs.push({ recipeId: recipe._id, dieticianId: recipe.dieticianId, recipeName: recipe.name, ingredientName: ing.name, index });
        }
      });
    }

    const existingShared = await Ingredient.find({}).select('dieticianId normalizedName').lean();
    const alreadySeeded = new Set(existingShared.map((i) => `${i.dieticianId}|${i.normalizedName}`));
    const toSeed = [...seedCandidates.entries()].filter(([key]) => !alreadySeeded.has(key));

    console.log(`\nSeed step: ${toSeed.length} distinct ingredient(s) to add to the shared library (${alreadySeeded.size} already present).`);
    console.log(`Fetch step: ${missingJobs.length} ingredient occurrence(s) across ${recipes.length} recipe(s) still have no image.`);

    const toProcessMissing = LIMIT ? missingJobs.slice(0, LIMIT) : missingJobs;
    if (LIMIT) console.log(`Fetch step limited to ${toProcessMissing.length} (--limit=${LIMIT}).`);

    if (!EXECUTE) {
      console.log('\nThis was a dry run - no API calls, no DB writes. Re-run with --execute to seed + fetch + persist.');
      return;
    }

    if (toSeed.length > 0) {
      await Ingredient.insertMany(
        toSeed.map(([, c]) => ({
          dieticianId: c.dieticianId,
          name: c.name.trim(),
          normalizedName: normalize(c.name),
          image: c.image,
          category: c.category,
        })),
        { ordered: false }
      ).catch((err) => {
        // Duplicate-key races (e.g. two recipes seeding the same name
        // concurrently) are harmless - the first write wins, log anything else.
        if (err.code !== 11000) console.error('Seed insert error:', err.message);
      });
      console.log(`Seeded ${toSeed.length} shared ingredient record(s).`);
    }

    let fetched = 0;
    let reused = 0;
    let failed = 0;
    for (let i = 0; i < toProcessMissing.length; i++) {
      const job = toProcessMissing[i];
      process.stdout.write(`[${i + 1}/${toProcessMissing.length}] "${job.ingredientName}" (${job.recipeName})... `);
      let wasReused = false;
      try {
        const result = await getOrCreateIngredientImage({
          dieticianId: job.dieticianId,
          name: job.ingredientName,
        });
        wasReused = result.reused;
        if (result.image) {
          await Recipe.updateOne(
            { _id: job.recipeId },
            { $set: { [`ingredients.${job.index}.image`]: result.image } }
          );
          if (wasReused) reused++;
          else fetched++;
          console.log(wasReused ? 'reused' : 'fetched');
        } else {
          failed++;
          console.log('no image found');
        }
      } catch (error) {
        failed++;
        console.log(`error: ${error.message}`);
      }
      // Only the fresh Pexels fetches need pacing - reused lookups are a
      // plain DB read with no external rate limit.
      if (!wasReused && i < toProcessMissing.length - 1) await sleep(DELAY_MS);
    }

    console.log(`\n=== DONE === Fetched fresh: ${fetched}, Reused from shared library: ${reused}, Failed/skipped: ${failed}`);
  } catch (error) {
    console.error('Backfill failed:', error);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
    console.log('Disconnected from MongoDB.');
  }
}

main();
