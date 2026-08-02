/**
 * Adds Hindi + Marathi translations to the exercises seeded by
 * seed-home-workout-exercises.js (tags: ['home-workout']) for a dietician,
 * so the patient-app language switcher (exercise_view.dart, reusing
 * RecipeLanguageService) has something to switch between for them - they
 * were originally created without any language selected.
 *
 * Usage:
 *   node scripts/translate-home-workout-exercises.js            # dry run
 *   node scripts/translate-home-workout-exercises.js --execute   # translate + save
 */

// Same DNS fix as seed-home-workout-exercises.js - the default system
// resolver on this machine doesn't handle mongodb+srv://'s SRV/TXT lookups.
require('dns').setServers(['8.8.8.8', '1.1.1.1']);

require('dotenv').config();
const mongoose = require('mongoose');
const { generateExerciseTranslations } = require('../utils/openaiClient');

const EXECUTE = process.argv.includes('--execute');
const dieticianArg = process.argv.find((a) => a.startsWith('--dietician='));
const DIETICIAN_EMAIL = dieticianArg ? dieticianArg.split('=')[1] : 'tejasvini@docwellness.fit';
const LANGUAGES = ['Hindi', 'Marathi'];

async function main() {
  console.log(EXECUTE ? '=== EXECUTING home-workout translation ===' : '=== DRY RUN (pass --execute to write) ===');

  console.log('Connecting to MongoDB...');
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected.');

  try {
    const { User, Exercise } = require('../models');
    const dietician = await User.findOne({ email: DIETICIAN_EMAIL, role: 'dietician' });
    if (!dietician) throw new Error(`Dietician account not found: ${DIETICIAN_EMAIL}`);
    console.log(`Target dietician: ${dietician.profile?.fullName || dietician.email} (${dietician._id})`);

    const exercises = await Exercise.find({ dieticianId: dietician._id, tags: 'home-workout' });
    console.log(`\nFound ${exercises.length} home-workout exercise(s).`);

    const toTranslate = exercises.filter((ex) => {
      const hasAll = LANGUAGES.every((lang) => ex.translations && ex.translations[lang]);
      if (hasAll) console.log(`  [skip: already translated] "${ex.name}"`);
      return !hasAll;
    });

    console.log(`\n=== PLAN: translate ${toTranslate.length} exercise(s) into ${LANGUAGES.join(', ')} ===`);
    toTranslate.forEach((e, i) => console.log(`${i + 1}. "${e.name}"`));

    if (!EXECUTE) {
      console.log('\nThis was a dry run - no AI calls, no DB writes. Re-run with --execute to translate these.');
      return;
    }

    let updated = 0;
    let failed = 0;
    for (const ex of toTranslate) {
      try {
        console.log(`\nTranslating: "${ex.name}"...`);
        const translations = await generateExerciseTranslations(
          { name: ex.name, description: ex.description, instructions: ex.instructions },
          LANGUAGES
        );

        const gotLanguages = Object.keys(translations);
        if (gotLanguages.length === 0) {
          console.log(`  ✗ No translations returned for "${ex.name}" - skipping save`);
          failed++;
          continue;
        }

        ex.translations = { ...(ex.translations || {}), ...translations };
        const existingLanguages = new Set(ex.language || ['English']);
        gotLanguages.forEach((l) => existingLanguages.add(l));
        ex.language = [...existingLanguages];
        await ex.save();

        updated++;
        console.log(`  ✓ Translated "${ex.name}" into: ${gotLanguages.join(', ')}`);
      } catch (err) {
        failed++;
        console.error(`  ✗ FAILED "${ex.name}": ${err.message}`);
      }
    }

    console.log(`\nDone. Updated ${updated} exercise(s), ${failed} failure(s).`);
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
