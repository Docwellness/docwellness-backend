/**
 * Bulk-imports a hand-authored recipe dataset (name/category/servingTime/
 * ingredients already fully specified - no AI generation needed) as Recipe
 * documents for a single dietician. See
 * openspec/changes/recipe-database-hand-authored-batch-import.
 *
 * Mirrors scripts/add-slot-coverage-recipes.js's structure minus the AI
 * generation step: dry-run by default, --execute to write, skip-if-name-
 * exists per dietician, explicit await syncV1FromRecipe(...) after each
 * create (the fire-and-forget post-save hook can lose a race against
 * mongoose.disconnect() on the last document(s) written otherwise - see
 * the prior change's notes). No RecipeVersion documents are ever inserted
 * directly.
 *
 * Usage:
 *   node scripts/import-hand-authored-recipes.js [datasetPath]            # dry run
 *   node scripts/import-hand-authored-recipes.js [datasetPath] --execute   # write
 *   (datasetPath defaults to scripts/data/hand-authored-batch-1.json)
 */

require('dotenv').config();
require('dns').setServers(['8.8.8.8', '1.1.1.1']);
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const EXECUTE = process.argv.includes('--execute');
const DATASET_PATH = process.argv.find((a) => a.endsWith('.json')) ||
  path.join(__dirname, 'data', 'hand-authored-batch-1.json');
const DIETICIAN_EMAIL = 'tejasvini@docwellness.fit';

const VALID_UNITS = ['g', 'ml', 'cup', 'tbsp', 'tsp', 'piece', 'nos', 'bowl', 'egg', 'slice'];

async function main() {
  console.log(EXECUTE ? '=== EXECUTING hand-authored batch import ===' : '=== DRY RUN (pass --execute to write) ===');
  console.log(`Dataset: ${DATASET_PATH}`);

  const dataset = JSON.parse(fs.readFileSync(DATASET_PATH, 'utf8'));
  console.log(`Loaded ${dataset.length} recipe(s) from dataset.`);

  console.log('Connecting to MongoDB...');
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected.');

  try {
    const { User, Recipe } = require('../models');
    const { syncV1FromRecipe } = require('../services/recipeVersioningService');
    const dietician = await User.findOne({ email: DIETICIAN_EMAIL, role: 'dietician' });
    if (!dietician) throw new Error(`Dietician account not found: ${DIETICIAN_EMAIL}`);
    console.log(`Target dietician: ${dietician.profile?.fullName || dietician.email} (${dietician._id})`);

    const toProcess = [];
    for (const entry of dataset) {
      const existing = await Recipe.findOne({
        dieticianId: dietician._id,
        name: new RegExp(`^${entry.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'),
      });
      if (existing) {
        console.log(`  [skip: already in DB] "${entry.name}" (${entry.servingTime})`);
        continue;
      }
      toProcess.push(entry);
    }

    console.log(`\n=== PLAN: ${toProcess.length} recipe(s), ${dataset.length - toProcess.length} skipped ===`);
    toProcess.forEach((e, i) => console.log(`${i + 1}. "${e.name}" -> ${e.servingTime}`));

    if (!EXECUTE) {
      console.log('\nThis was a dry run - no DB writes. Re-run with --execute to create these.');
      return;
    }

    let created = 0;
    let failed = 0;
    for (const entry of toProcess) {
      try {
        const safeIngredients = (entry.ingredients || []).map((ing) => ({
          name: ing.name,
          quantity: ing.quantity,
          unit: VALID_UNITS.includes(ing.unit) ? ing.unit : 'g',
        }));

        const recipe = await Recipe.create({
          dieticianId: dietician._id,
          name: entry.name,
          category: entry.category || 'Other',
          cuisine: entry.category || 'Other',
          servingTime: entry.servingTime,
          servings: 1,
          dietaryHabits: { vegetarian: !safeIngredients.some((i) => /chicken|fish|egg|mutton|prawn/i.test(i.name)) },
          freeFrom: {},
          ingredients: safeIngredients,
          instructions: [],
          language: ['English'],
        });
        await syncV1FromRecipe(recipe);

        created++;
        console.log(`  ✓ Created "${entry.name}" [${entry.servingTime}, ${entry.category}]`);
      } catch (err) {
        failed++;
        console.error(`  ✗ FAILED "${entry.name}": ${err.message}`);
      }
    }

    console.log(`\n=== DONE === Created: ${created}, Failed: ${failed}, Skipped: ${dataset.length - toProcess.length}`);
  } catch (error) {
    console.error('Import failed:', error);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
    console.log('Disconnected from MongoDB.');
  }
}

main();
