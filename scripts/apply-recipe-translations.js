/**
 * Applies hand-authored Hindi + Marathi translations to Recipe documents
 * that are missing them.
 *
 * Data file: scripts/data/recipe-translations.json - an array of
 *   { id, name, Hindi: {...}, Marathi: {...} }
 * where each language object is
 *   { name, description, ingredients: [{name, description}], cookingSteps: [string], warnings: [string] }
 * and `ingredients` aligns positionally with the recipe's English `ingredients`.
 *
 * Safety:
 *  - dry run by default; pass --execute to write.
 *  - only sets translations for languages that are currently MISSING/empty
 *    (never overwrites an existing usable translation).
 *  - validates ingredient-array length against the live recipe before writing.
 *  - adds 'Hindi'/'Marathi' to `language[]` alongside the existing values.
 *
 * Usage:
 *   node scripts/apply-recipe-translations.js            # dry run
 *   node scripts/apply-recipe-translations.js --execute  # write
 *   node scripts/apply-recipe-translations.js --force    # (with --execute) overwrite existing translations too
 */

require('dns').setServers(['8.8.8.8', '1.1.1.1']);
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const EXECUTE = process.argv.includes('--execute');
const FORCE = process.argv.includes('--force');
const LANGS = ['Hindi', 'Marathi'];
const DATA_PATH = path.join(__dirname, 'data', 'recipe-translations.json');

function hasUsableTranslation(t) {
  if (!t) return false;
  const steps = Array.isArray(t.cookingSteps) ? t.cookingSteps.filter((s) => (s || '').trim()) : [];
  return Boolean((t.name || '').trim()) && steps.length > 0;
}

/** A translation is well-formed if it has a name, matching-length ingredients, and >=1 step. */
function validateEntry(langObj, recipe, lang, label) {
  const problems = [];
  if (!langObj || typeof langObj !== 'object') return [`${label} [${lang}]: missing object`];
  if (!(langObj.name || '').trim()) problems.push(`${label} [${lang}]: empty name`);
  const ing = Array.isArray(langObj.ingredients) ? langObj.ingredients : [];
  const enCount = (recipe.ingredients || []).length;
  if (ing.length !== enCount) {
    problems.push(`${label} [${lang}]: ingredients ${ing.length} != recipe ${enCount}`);
  }
  const steps = Array.isArray(langObj.cookingSteps) ? langObj.cookingSteps.filter((s) => (s || '').trim()) : [];
  if (steps.length === 0) problems.push(`${label} [${lang}]: no cooking steps`);
  const enSteps = (recipe.instructions || []).length;
  if (enSteps && steps.length !== enSteps) {
    problems.push(`${label} [${lang}]: steps ${steps.length} != recipe ${enSteps} (soft)`);
  }
  // Reject Latin letters glued inside a Devanagari word (the gpt-4o-mini failure
  // mode, e.g. "क्रीमiness"). Standalone Latin tokens (units, numerals, "kg") are fine.
  const glued = JSON.stringify(langObj).match(/[ऀ-ॿ]+[A-Za-z]|[A-Za-z][ऀ-ॿ]+/g);
  if (glued) problems.push(`${label} [${lang}]: Latin/Devanagari glued: ${[...new Set(glued)].slice(0, 5).join(', ')}`);
  return problems;
}

async function main() {
  if (!fs.existsSync(DATA_PATH)) {
    console.error(`Data file not found: ${DATA_PATH}`);
    process.exit(1);
  }
  const data = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
  console.log(`${EXECUTE ? '=== EXECUTING ===' : '=== DRY RUN (pass --execute to write) ==='}`);
  console.log(`Entries in data file: ${data.length}\n`);

  await mongoose.connect(process.env.MONGODB_URI);
  const Recipe = require('../models/Recipe');

  let willWrite = 0;
  let skippedExisting = 0;
  let invalid = 0;
  const notFound = [];
  const allProblems = [];

  for (const entry of data) {
    const recipe = await Recipe.findById(entry.id);
    if (!recipe) {
      notFound.push(`${entry.id}  (${entry.name})`);
      continue;
    }

    const current = recipe.translations instanceof Map
      ? Object.fromEntries(recipe.translations)
      : recipe.translations || {};

    const toSet = [];
    for (const lang of LANGS) {
      const already = hasUsableTranslation(current[lang]);
      if (already && !FORCE) {
        skippedExisting++;
        continue;
      }
      const problems = validateEntry(entry[lang], recipe, lang, entry.name);
      const hard = problems.filter((p) => !p.endsWith('(soft)'));
      if (hard.length) {
        allProblems.push(...problems);
        invalid++;
        continue;
      }
      if (problems.length) allProblems.push(...problems); // soft warnings only
      toSet.push(lang);
    }

    if (toSet.length === 0) continue;
    willWrite++;
    console.log(`  ${recipe.name.padEnd(42)} -> ${toSet.join(', ')}`);

    if (EXECUTE) {
      for (const lang of toSet) {
        const src = entry[lang];
        recipe.translations.set(lang, {
          name: src.name,
          description: src.description || '',
          ingredients: (src.ingredients || []).map((i) => ({
            name: i.name || '',
            description: i.description || '',
          })),
          cookingSteps: src.cookingSteps || [],
          warnings: src.warnings || [],
        });
      }
      const langs = new Set(recipe.language && recipe.language.length ? recipe.language : ['English']);
      toSet.forEach((l) => langs.add(l));
      recipe.language = [...langs];
      await recipe.save();
    }
  }

  console.log('\n--- summary ---');
  console.log(`Recipes to update: ${willWrite}`);
  console.log(`Language entries skipped (already translated): ${skippedExisting}`);
  console.log(`Language entries rejected (validation): ${invalid}`);
  if (notFound.length) {
    console.log(`\nNOT FOUND (${notFound.length}):`);
    notFound.forEach((n) => console.log(`  ${n}`));
  }
  if (allProblems.length) {
    console.log(`\nVALIDATION NOTES (${allProblems.length}):`);
    [...new Set(allProblems)].forEach((p) => console.log(`  ${p}`));
  }
  if (EXECUTE) console.log('\nDone.');
  else console.log('\nDry run only - nothing written.');

  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
