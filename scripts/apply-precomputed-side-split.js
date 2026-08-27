/**
 * Applies the pre-generated main/side recipe split in scripts/data/
 * side-split-mains.json, side-split-new-sides.json, and
 * side-split-food-items.json to matching documents - no AI calls at
 * runtime, matches the exact convention of
 * scripts/apply-precomputed-cooking-steps.js (see that file's own header
 * comment for why: real AI generation calls are too slow/costly to
 * re-run against every environment, so content is generated once locally
 * against dev - already verified correct there, see scripts/
 * split-main-and-side-recipes.js and scripts/normalize-split-recipe-
 * ingredients.js's own runs - and exported to these JSON files instead).
 *
 * Three phases, in order:
 *   1. Mains - matches each entry by (dieticianId, name=oldName) - the
 *      recipe's ORIGINAL bundled name (e.g. "Bharli Vangi with Bhakri"),
 *      not by _id, since a target DB's document _ids for this content
 *      can't be assumed to match dev's (see apply-precomputed-cooking-
 *      steps.js's own comment on prod not being a live mirror of dev).
 *      Skips a recipe whose name already equals the new name (already
 *      applied - safe to re-run). Overwrites name/description/ingredients/
 *      instructions/nutrition/translations, then re-syncs its
 *      RecipeVersion.
 *   2. New sides - creates each one (tags:['side']) if no recipe with
 *      that exact name already exists for this dietician. Existing sides
 *      this split reuses (Chapati, Jowar Bhakri, Bajra Bhakri, Steamed
 *      Rice) need no action here - they're only ever referenced generically
 *      by tag at diet-generation time (services/recipeSelectionEngine.js),
 *      never by an explicit id/link, so as long as they already exist
 *      under any of those names there's nothing to apply.
 *   3. FoodItem fixes - adds Ghee's missing tbsp/cup unitConversions (only
 *      if Ghee exists and doesn't already have them), creates any of the 7
 *      new FoodItems that don't already exist.
 *
 * Connects via connectDB() (config/database.js) - works against whichever
 * MONGODB_URI/MONGODB_TLS_CA_BASE64 is set when this runs, dev or prod,
 * same as every other script here. DIETICIAN_ID is the same hardcoded id
 * apply-precomputed-cooking-steps.js already established mirrors 1:1
 * between dev and prod (User document cloned by _id, only email differs).
 *
 * Idempotent - re-running only touches what's still unapplied.
 *
 * Usage:
 *   node scripts/apply-precomputed-side-split.js            # dry run
 *   node scripts/apply-precomputed-side-split.js --execute  # write
 */
require('dotenv').config();
const path = require('path');
const connectDB = require('../config/database');
const { syncV1FromRecipe } = require('../services/recipeVersioningService');

const EXECUTE = process.argv.includes('--execute');
const DIETICIAN_ID = '6a5e0c3619fa51068811c304';

const MAINS = require(path.join(__dirname, 'data', 'side-split-mains.json'));
const NEW_SIDES = require(path.join(__dirname, 'data', 'side-split-new-sides.json'));
const FOOD_ITEMS = require(path.join(__dirname, 'data', 'side-split-food-items.json'));

async function applyMains(dietician) {
  const { Recipe } = require('../models');
  let updated = 0;
  let alreadyApplied = 0;
  let missing = 0;
  let failed = 0;

  for (const entry of MAINS) {
    const recipe = await Recipe.findOne({ dieticianId: dietician._id, name: entry.oldName });
    if (!recipe) {
      const already = await Recipe.findOne({ dieticianId: dietician._id, name: entry.name });
      if (already) {
        console.log(`ALREADY APPLIED: "${entry.oldName}" -> "${entry.name}"`);
        alreadyApplied++;
      } else {
        console.log(`MISSING (no matching recipe on this DB): "${entry.oldName}"`);
        missing++;
      }
      continue;
    }

    console.log(`"${entry.oldName}" -> "${entry.name}" [${recipe._id}]`);
    console.log(`  ingredients: ${entry.ingredients.map((i) => i.name).join(', ')}`);

    if (!EXECUTE) continue;
    try {
      recipe.name = entry.name;
      recipe.description = entry.description;
      recipe.ingredients = entry.ingredients;
      recipe.instructions = entry.instructions;
      recipe.nutrition = entry.nutrition;
      for (const [lang, translation] of Object.entries(entry.translations || {})) {
        recipe.translations.set(lang, translation);
      }
      await recipe.save();
      await syncV1FromRecipe(recipe);
      console.log('  saved + synced.');
      updated++;
    } catch (err) {
      console.error(`  FAILED: ${err.message}`);
      failed++;
    }
  }

  console.log(`\nMains: updated=${updated} alreadyApplied=${alreadyApplied} missing=${missing} failed=${failed}`);
}

async function applyNewSides(dietician) {
  const { Recipe } = require('../models');
  let created = 0;
  let skipped = 0;
  let failed = 0;

  for (const side of NEW_SIDES) {
    const existing = await Recipe.findOne({ dieticianId: dietician._id, name: side.name });
    if (existing) {
      console.log(`SKIP (already exists): "${side.name}"`);
      skipped++;
      continue;
    }

    console.log(`CREATE: "${side.name}" [tags: ${side.tags}] - ${side.ingredients.map((i) => i.name).join(', ')}`);
    if (!EXECUTE) continue;
    try {
      await Recipe.create({ ...side, dieticianId: dietician._id });
      created++;
    } catch (err) {
      console.error(`  FAILED: ${err.message}`);
      failed++;
    }
  }

  console.log(`\nNew sides: created=${created} skipped=${skipped} failed=${failed}`);
}

async function applyFoodItems() {
  const { FoodItem } = require('../models');
  let gheeFixed = false;
  let created = 0;
  let skipped = 0;
  let failed = 0;

  if (FOOD_ITEMS.gheeUnitConversions) {
    const ghee = await FoodItem.findOne({ normalizedName: 'ghee' });
    if (!ghee) {
      console.log('SKIP Ghee fix: no "Ghee" FoodItem on this DB');
    } else if (ghee.unitConversions?.tbsp) {
      console.log('SKIP Ghee fix: already has tbsp conversion');
    } else {
      console.log(`Ghee.unitConversions: ${JSON.stringify(ghee.unitConversions)} -> ${JSON.stringify(FOOD_ITEMS.gheeUnitConversions)}`);
      if (EXECUTE) {
        try {
          ghee.unitConversions = FOOD_ITEMS.gheeUnitConversions;
          await ghee.save();
          gheeFixed = true;
        } catch (err) {
          console.error(`  FAILED: ${err.message}`);
          failed++;
        }
      }
    }
  }

  for (const item of FOOD_ITEMS.newItems) {
    const normalizedName = item.name.trim().toLowerCase();
    const existing = await FoodItem.findOne({ normalizedName });
    if (existing) {
      console.log(`SKIP (already exists): FoodItem "${item.name}"`);
      skipped++;
      continue;
    }
    console.log(`CREATE: FoodItem "${item.name}" - ${JSON.stringify(item.nutritionPer100g)}`);
    if (!EXECUTE) continue;
    try {
      await FoodItem.create({
        name: item.name,
        normalizedName,
        nutritionPer100g: item.nutritionPer100g,
        unitConversions: item.unitConversions,
        density: item.density ?? null,
        dataSource: 'tier1-seed',
      });
      created++;
    } catch (err) {
      console.error(`  FAILED: ${err.message}`);
      failed++;
    }
  }

  console.log(`\nFoodItems: gheeFixed=${gheeFixed} created=${created} skipped=${skipped} failed=${failed}`);
}

async function main() {
  console.log(EXECUTE ? '=== EXECUTING precomputed side-split apply ===' : '=== DRY RUN (pass --execute to write) ===');
  console.log(`Loaded ${MAINS.length} main(s), ${NEW_SIDES.length} new side(s), ${FOOD_ITEMS.newItems.length} new FoodItem(s).\n`);

  await connectDB();
  try {
    const { User } = require('../models');
    const dietician = await User.findById(DIETICIAN_ID);
    if (!dietician) throw new Error(`Dietician not found: ${DIETICIAN_ID}`);
    console.log(`Target dietician: ${dietician.profile?.fullName || dietician.email} (${dietician._id})\n`);

    console.log('=== Phase 1: mains ===');
    await applyMains(dietician);

    console.log('\n=== Phase 2: new sides ===');
    await applyNewSides(dietician);

    console.log('\n=== Phase 3: FoodItem fixes ===');
    await applyFoodItems();

    if (!EXECUTE) console.log('\nThis was a dry run - no writes. Re-run with --execute to apply.');
  } finally {
    await require('mongoose').disconnect();
    console.log('\nDisconnected from MongoDB.');
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
