/**
 * Copies verified-good Hindi + Marathi translations from the dev catalog
 * (already 214/214 fully translated) onto the matching-by-name recipes on
 * production, which is missing translations entirely for 98 recipes (see
 * audit-recipe-translations-prod.js). Reuses existing, human-verified
 * content instead of re-authoring 98 recipes from scratch - every one of
 * these 98 names already exists in dev with a good translation.
 *
 * Data source: scripts/data/dev-translations-for-prod-gap.json (exported
 * from dev via scripts/_export_dev_translations.js - each entry carries
 * dev's own ingredient/step COUNT alongside its translations, so this
 * script can refuse to copy onto a prod recipe whose English content has
 * a different shape, rather than silently misaligning positional data).
 *
 * Also sets Recipe.language to include Hindi/Marathi for every recipe it
 * touches (see sync-recipe-languages-prod.js - the same field the app's
 * language-pill row actually reads).
 *
 * Usage:
 *   node scripts/copy-dev-translations-to-prod.js             # dry run
 *   node scripts/copy-dev-translations-to-prod.js --execute   # write
 *   node scripts/copy-dev-translations-to-prod.js --only="Adai Dosa (Lentil Dosa)" [--execute]
 */
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const connectDB = require('../config/database');

const EXECUTE = process.argv.includes('--execute');
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) || '').slice('--only='.length) || null;

async function main() {
  console.log(EXECUTE ? '=== EXECUTING ===' : '=== DRY RUN (pass --execute to write) ===');
  await connectDB();
  const Recipe = require('../models/Recipe');

  const dataPath = path.join(__dirname, 'data', 'dev-translations-for-prod-gap.json');
  const entries = JSON.parse(fs.readFileSync(dataPath, 'utf8')).filter((e) => !ONLY || e.name === ONLY);
  console.log(`Loaded ${entries.length} candidate recipe(s) from ${dataPath}\n`);

  let copied = 0;
  let skipped = 0;

  for (const entry of entries) {
    try {
      const prodRecipe = await Recipe.findOne({ name: entry.name }).select('name language translations ingredients instructions').lean();
      if (!prodRecipe) {
        console.log(`!! ${entry.name}: not found on prod - skipped`);
        skipped++;
        continue;
      }

      const prodIngCount = (prodRecipe.ingredients || []).length;
      const prodStepCount = (prodRecipe.instructions || []).length;
      if (prodIngCount !== entry.engIngredientCount || prodStepCount !== entry.engStepCount) {
        console.log(
          `!! ${entry.name}: shape mismatch - prod has ${prodIngCount} ingredients/${prodStepCount} steps, ` +
            `dev's translation was authored for ${entry.engIngredientCount}/${entry.engStepCount} - skipped (needs hand review)`
        );
        skipped++;
        continue;
      }

      const alreadyHi = prodRecipe.translations?.Hindi?.name;
      const alreadyMr = prodRecipe.translations?.Marathi?.name;
      if (alreadyHi && alreadyMr) {
        console.log(`- ${entry.name}: prod already has both translations - skipped (not overwritten)`);
        skipped++;
        continue;
      }

      const currentLangs = new Set(prodRecipe.language || ['English']);
      currentLangs.add('Hindi');
      currentLangs.add('Marathi');

      console.log(`### ${entry.name} (${prodRecipe._id})`);
      console.log(`  Hindi name: ${entry.Hindi?.name}`);
      console.log(`  Marathi name: ${entry.Marathi?.name}`);
      copied++;

      if (EXECUTE) {
        const res = await Recipe.updateOne(
          { _id: prodRecipe._id },
          {
            $set: {
              'translations.Hindi': entry.Hindi,
              'translations.Marathi': entry.Marathi,
              language: [...currentLangs],
            },
          }
        );
        console.log(`  -> written (matched ${res.matchedCount}, modified ${res.modifiedCount})`);
      }
      console.log();
    } catch (err) {
      console.log(`!! ${entry.name}: unexpected error, skipped: ${err.message}`);
      skipped++;
    }
  }

  console.log('--- summary ---');
  console.log(`Recipes ${EXECUTE ? 'updated' : 'to update'}: ${copied}`);
  console.log(`Recipes skipped: ${skipped}`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
