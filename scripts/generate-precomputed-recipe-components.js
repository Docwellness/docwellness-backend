/**
 * ONE-OFF LOCAL GENERATION SCRIPT - NOT for prod. Run once, locally,
 * against dev to produce scripts/data/hand-authored-batch-1-components.json,
 * the same "generate once locally, apply as plain data on prod" pattern
 * scripts/apply-precomputed-cooking-steps.js already established for the
 * equivalent `instructions` gap (see that script's own header comment for
 * the full rationale: Coolify's Scheduled Task/one-off job runner has no
 * Terminal tab, no streaming output, and an unknown execution timeout, so
 * ~99 sequential real OpenAI calls is unsafe to run there directly).
 *
 * Finds every recipe with neither `components` nor a usable `servingSize`
 * (STEP 3's exact candidate set in scripts/backfill-recipe-catalog-fixes.js),
 * calls generateComponentsForFixedIngredients (utils/openaiClient.js) for
 * each, and writes the full result list to the data file - never touches
 * the database itself.
 *
 * Usage:
 *   node scripts/generate-precomputed-recipe-components.js
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const connectDB = require('../config/database');

const OUTPUT_FILE = path.join(__dirname, 'data', 'hand-authored-batch-1-components.json');

async function main() {
  console.log('Connecting to MongoDB...');
  await connectDB();
  console.log('Connected.');

  try {
    const { Recipe } = require('../models');
    const { generateComponentsForFixedIngredients } = require('../utils/openaiClient');

    const allCandidates = (
      await Recipe.find({
        $or: [{ components: { $exists: false } }, { components: { $size: 0 } }],
      }).sort({ servingTime: 1, name: 1 })
    ).filter((r) => !(r.servingSize?.quantity > 0 && r.servingSize?.unit));

    console.log(`Found ${allCandidates.length} recipe(s) needing generated components.\n`);

    const results = [];
    let failed = 0;

    for (const recipe of allCandidates) {
      let components;
      try {
        components = await generateComponentsForFixedIngredients({
          name: recipe.name,
          servingTime: recipe.servingTime,
          category: recipe.category,
          ingredients: (recipe.ingredients || []).map((i) => ({ name: i.name, quantity: i.quantity, unit: i.unit })),
        });
      } catch (err) {
        console.error(`FAILED to generate for "${recipe.name}": ${err.message}`);
        failed++;
        continue;
      }

      if (!Array.isArray(components) || components.length === 0) {
        console.error(`FAILED (no components returned) for "${recipe.name}"`);
        failed++;
        continue;
      }

      console.log(`"${recipe.name}" [${recipe.servingTime}] -> ${JSON.stringify(components)}`);
      results.push({ name: recipe.name, servingTime: recipe.servingTime, components });
    }

    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(results, null, 2) + '\n');
    console.log(`\n=== DONE === generated=${results.length} failed=${failed} -> wrote ${OUTPUT_FILE}`);
  } finally {
    await mongoose.disconnect();
    console.log('Disconnected from MongoDB.');
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
