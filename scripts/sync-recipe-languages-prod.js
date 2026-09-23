/**
 * Fixes recipes where usable Hindi/Marathi translation content already
 * exists in `translations`, but the `language` array field doesn't list
 * it - which is what the app's language-pill row actually reads (see
 * docwellness-dietician/lib/app/modules/receipes/views/recipe_details.dart
 * availableLanguages getter), so the translated content silently never
 * shows even though it's fully there and correct.
 *
 * A translation "counts" as usable with the same bar
 * audit-recipe-translations.js uses: non-empty name AND >=1 cooking step.
 *
 * Only ever ADDS a language to the `language` array - never removes one,
 * never touches `translations` content itself (see
 * apply-recipe-translation-fixes-prod.js for that).
 *
 * Usage:
 *   node scripts/sync-recipe-languages-prod.js             # dry run
 *   node scripts/sync-recipe-languages-prod.js --execute   # write
 */
require('dotenv').config({ quiet: true });
const connectDB = require('../config/database');

const EXECUTE = process.argv.includes('--execute');
const LANGS = ['Hindi', 'Marathi'];

function hasUsableTranslation(t) {
  if (!t) return false;
  const name = (t.name || '').trim();
  const steps = Array.isArray(t.cookingSteps) ? t.cookingSteps.filter((s) => (s || '').trim()) : [];
  return Boolean(name) && steps.length > 0;
}

async function main() {
  console.log(EXECUTE ? '=== EXECUTING ===' : '=== DRY RUN (pass --execute to write) ===');
  await connectDB();
  const Recipe = require('../models/Recipe');

  const recipes = await Recipe.find({}).select('name language translations').lean();
  console.log(`Scanned ${recipes.length} recipes.\n`);

  let touched = 0;
  for (const r of recipes) {
    const currentLangs = new Set(r.language || ['English']);
    const missing = LANGS.filter((l) => hasUsableTranslation((r.translations || {})[l]) && !currentLangs.has(l));

    if (!missing.length) continue;
    touched++;
    const newLangs = [...currentLangs, ...missing];
    console.log(`### ${r.name} (${r._id})`);
    console.log(`  language: ${JSON.stringify(r.language)} -> ${JSON.stringify(newLangs)}`);
    console.log(`  (usable translation content already present for: ${missing.join(', ')})`);

    if (EXECUTE) {
      const res = await Recipe.updateOne({ _id: r._id }, { $set: { language: newLangs } });
      console.log(`  -> written (matched ${res.matchedCount}, modified ${res.modifiedCount})`);
    }
    console.log();
  }

  console.log('--- summary ---');
  console.log(`Recipes ${EXECUTE ? 'fixed' : 'to fix'}: ${touched}`);
  if (!touched) console.log('(No mismatch found - every recipe with usable translations already lists them in `language`.)');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
