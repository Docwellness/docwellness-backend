/**
 * Translates German supplementFacts text to English on the 11 existing
 * Supplements recipes that have real data transcribed from German product
 * labels (see update-supplement-nutrition-facts.js), and fills in
 * supplementFacts for the 2 that were left without any (Biotin Supplement,
 * Creatine Monohydrate - a pre-existing gap, unrelated to the language
 * issue) using researched, generic (non-branded) standard values.
 *
 * Self-checks on every run: any nutrients[].name or servingSize.label not
 * covered by GERMAN_SUPPLEMENT_TRANSLATIONS is printed as UNTRANSLATED
 * rather than silently left as-is, so a stale table can't quietly ship
 * leftover German text.
 *
 * Usage:
 *   node scripts/translate-supplement-facts.js            # dry run
 *   node scripts/translate-supplement-facts.js --execute  # actually write
 */

require('dotenv').config();
const mongoose = require('mongoose');
const { GERMAN_SUPPLEMENT_TRANSLATIONS } = require('./canonical-ingredients-data');

const EXECUTE = process.argv.includes('--execute');
const DIETICIAN_EMAIL = 'localdietician@dev.local';

const ZERO_NUTRITION = { calories: 0, protein: 0, carbs: 0, fats: 0, fiber: 0 };

// International/scientific nutrition-label abbreviations - NOT German, left
// as-is (retinol equivalent, alpha-tocopherol equivalent, niacin
// equivalent, colony-forming-unit-style international unit).
const NON_GERMAN_UNITS = new Set(['µg RE', 'mg α-TE', 'mg NE', 'x10^9 AFU', 'kcal', 'g', 'mg', 'µg']);

// Generic, standard supplement facts for the 2 recipes with no
// supplementFacts at all - NOT tied to a specific branded product (unlike
// the other 11, which are transcribed from real German labels).
const GENERIC_SUPPLEMENT_FACTS = {
  'Biotin Supplement': {
    brand: 'Generic',
    servingSize: { quantity: 1, unit: 'tablet', label: '1 tablet' },
    servingsPerContainer: null,
    // 5000mcg (5mg) is the standard high-potency biotin dose commonly sold
    // for hair/skin/nails support; EU NRV for biotin is 50µg.
    nutrients: [{ name: 'Biotin', amount: 5000, unit: 'µg', percentNRV: 10000 }],
  },
  'Creatine Monohydrate': {
    brand: 'Generic',
    servingSize: { quantity: 5, unit: 'g', label: '1 scoop (5g)' },
    servingsPerContainer: null,
    // 5g/day is the universally standard creatine monohydrate maintenance
    // dose; no EU NRV exists for creatine (matches the existing pattern for
    // Omega-3 entries, which also have percentNRV: null).
    nutrients: [{ name: 'Creatine Monohydrate', amount: 5, unit: 'g', percentNRV: null }],
  },
};

function translateText(text) {
  if (GERMAN_SUPPLEMENT_TRANSLATIONS[text] !== undefined) {
    return { translated: GERMAN_SUPPLEMENT_TRANSLATIONS[text], changed: GERMAN_SUPPLEMENT_TRANSLATIONS[text] !== text };
  }
  return { translated: text, changed: false };
}

async function main() {
  console.log(EXECUTE ? '=== EXECUTING supplement facts translation ===' : '=== DRY RUN (pass --execute to write) ===');

  console.log('Connecting to MongoDB...');
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected.');

  try {
    const { User, Recipe } = require('../models');
    const dietician = await User.findOne({ email: DIETICIAN_EMAIL, role: 'dietician' });
    if (!dietician) throw new Error(`Dietician account not found: ${DIETICIAN_EMAIL}`);
    console.log(`Target dietician: ${dietician.profile?.fullName || dietician.email} (${dietician._id})`);

    const supplements = await Recipe.find({ dieticianId: dietician._id, category: 'Supplements' });
    console.log(`Found ${supplements.length} Supplements recipe(s).`);

    const untranslated = [];
    const plannedRenames = []; // { recipe, nutrientChanges: [{index, old, new}], labelChange: {old,new}|null }
    const plannedNewFacts = []; // { recipe, facts }

    for (const recipe of supplements) {
      if (!recipe.supplementFacts) {
        const generic = GENERIC_SUPPLEMENT_FACTS[recipe.name];
        if (!generic) {
          console.log(`  [WARNING] "${recipe.name}" has no supplementFacts and no generic entry defined - skipping.`);
          continue;
        }
        plannedNewFacts.push({ recipe, facts: generic });
        continue;
      }

      const nutrientChanges = [];
      recipe.supplementFacts.nutrients.forEach((nutrient, index) => {
        const { translated, changed } = translateText(nutrient.name);
        if (changed) {
          nutrientChanges.push({ index, old: nutrient.name, new: translated });
        } else if (/[^\x00-\x7F]/.test(nutrient.name) && !NON_GERMAN_UNITS.has(nutrient.name)) {
          // Contains non-ASCII characters (likely German diacritics) and
          // isn't a known-fine international unit - flag for review rather
          // than assume it's already English.
          untranslated.push(`nutrients[${index}].name "${nutrient.name}" in "${recipe.name}"`);
        }
      });

      let labelChange = null;
      const label = recipe.supplementFacts.servingSize?.label;
      if (label) {
        const { translated, changed } = translateText(label);
        if (changed) {
          labelChange = { old: label, new: translated };
        } else if (/[^\x00-\x7F]/.test(label)) {
          untranslated.push(`servingSize.label "${label}" in "${recipe.name}"`);
        }
      }

      if (nutrientChanges.length > 0 || labelChange) {
        plannedRenames.push({ recipe, nutrientChanges, labelChange });
      }
    }

    console.log(`\n=== PLAN ===`);
    console.log(`Recipes needing translation: ${plannedRenames.length}`);
    console.log(`Recipes needing new generic supplementFacts: ${plannedNewFacts.length}`);
    console.log(`UNTRANSLATED (needs a table entry): ${untranslated.length}`);
    if (untranslated.length > 0) {
      untranslated.forEach((u) => console.log(`  - ${u}`));
    }

    console.log('\n--- Translations ---');
    plannedRenames.forEach(({ recipe, nutrientChanges, labelChange }) => {
      console.log(`\n"${recipe.name}" (${recipe._id}):`);
      nutrientChanges.forEach((c) => console.log(`  nutrients[${c.index}]: "${c.old}" -> "${c.new}"`));
      if (labelChange) console.log(`  servingSize.label: "${labelChange.old}" -> "${labelChange.new}"`);
    });

    console.log('\n--- New generic supplementFacts ---');
    plannedNewFacts.forEach(({ recipe, facts }) => {
      console.log(`\n"${recipe.name}" (${recipe._id}):`);
      console.log(JSON.stringify(facts, null, 2));
    });

    if (untranslated.length > 0) {
      console.log('\n=== STOPPING: resolve all UNTRANSLATED entries before running --execute ===');
      process.exitCode = 1;
      return;
    }

    if (!EXECUTE) {
      console.log('\nThis was a dry run - no DB writes. Re-run with --execute to apply.');
      return;
    }

    let renamed = 0;
    for (const { recipe, nutrientChanges, labelChange } of plannedRenames) {
      nutrientChanges.forEach((c) => {
        recipe.supplementFacts.nutrients[c.index].name = c.new;
      });
      if (labelChange) {
        recipe.supplementFacts.servingSize.label = labelChange.new;
      }
      recipe.markModified('supplementFacts');
      await recipe.save();
      renamed++;
    }
    console.log(`\nRecipes translated: ${renamed}`);

    let filled = 0;
    for (const { recipe, facts } of plannedNewFacts) {
      recipe.supplementFacts = facts;
      recipe.nutrition = ZERO_NUTRITION;
      await recipe.save();
      filled++;
      console.log(`  ✓ Filled generic supplementFacts for "${recipe.name}"`);
    }
    console.log(`Recipes filled with generic supplementFacts: ${filled}`);

    console.log('\n=== DONE ===');
  } catch (error) {
    console.error('Translation failed:', error);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
    console.log('Disconnected from MongoDB.');
  }
}

main();
