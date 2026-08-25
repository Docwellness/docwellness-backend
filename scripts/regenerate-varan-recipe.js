/**
 * Regenerates "Varan" from scratch via the same AI pipeline used to author
 * every other recipe (generateRecipeWithAI, generate mode) - its existing
 * content is almost entirely someone else's recipe: only its first step
 * (cooking toor dal) is genuinely Varan, the rest is Paneer Bhurji's own
 * preparation plus a koshimbir salad, most likely leaked in from the same
 * document-import issue as scripts/fix-usal-recipe-contamination.js's two
 * cases. Simply trimming would leave no complete dal preparation (no
 * tempering/tadka step at all), so this asks the AI for a proper
 * standalone Maharashtrian Varan instead of hand-authoring one.
 *
 * Preserves the existing document's _id/dieticianId/category/servingTime/
 * servings/dietaryHabits/freeFrom/components exactly - only replaces the
 * generated content fields (description, ingredients, instructions,
 * nutrition, translations, warnings). Recipe.save() triggers the existing
 * post-save V1-sync hook automatically (bumps to a new version instead of
 * mutating V1 if already prescribed to a patient - the same freeze
 * behavior as scripts/fix-usal-recipe-contamination.js).
 *
 * ALWAYS dry-run first (default) and read the generated recipe before
 * passing --execute - this is a real AI call, review it like any other
 * AI-generated recipe before it goes live.
 *
 * Usage:
 *   node scripts/regenerate-varan-recipe.js            # dry run
 *   node scripts/regenerate-varan-recipe.js --execute  # actually write
 */
require('dotenv').config();
const connectDB = require('../config/database');
const { generateRecipeWithAI } = require('../utils/openaiClient');

const EXECUTE = process.argv.includes('--execute');
const VARAN_RECIPE_ID = '6a50ef47d286aeeaeb756a27';

async function run() {
  await connectDB();
  try {
    const { Recipe } = require('../models');

    const recipe = await Recipe.findById(VARAN_RECIPE_ID);
    if (!recipe) {
      console.log(`No recipe found for id ${VARAN_RECIPE_ID} - nothing to do.`);
      return;
    }
    if (recipe.name !== 'Varan') {
      console.log(`Recipe ${VARAN_RECIPE_ID} is named "${recipe.name}", not "Varan" - stopping, check the id.`);
      return;
    }

    console.log('Current (contaminated) content:');
    console.log('  ingredients:', recipe.ingredients.map((i) => i.name).join(', '));
    console.log('  instructions:', recipe.instructions);

    const languages = recipe.language && recipe.language.length > 0 ? recipe.language : ['English'];
    const generated = await generateRecipeWithAI({
      name: 'Varan',
      servingTime: recipe.servingTime,
      servings: recipe.servings,
      dietaryHabits: recipe.dietaryHabits,
      freeFrom: recipe.freeFrom,
      aiNote: 'A plain, traditional Maharashtrian Varan - simple toor dal cooked with turmeric and salt, finished with a tadka (tempering) of ghee/oil, mustard and cumin seeds, and hing. Do not include paneer, bhurji, bhakri, or any salad - Varan on its own only.',
      languages,
    });

    console.log('\nNewly generated content:');
    console.log(JSON.stringify(generated, null, 2));

    if (!EXECUTE) {
      console.log('\nDry run only - pass --execute to apply.');
      return;
    }

    recipe.description = generated.description;
    recipe.ingredients = generated.ingredients;
    recipe.instructions = generated.cookingSteps;
    recipe.nutrition = generated.nutrition;
    // Recipe has no top-level `warnings` field (only translations.<lang>.
    // warnings does) - generated.warnings has nowhere to go here.
    // components deliberately left untouched - Varan's own real-world
    // serving amount (see Recipe.components) is independent of this
    // content fix and shouldn't be silently overwritten by whatever the
    // AI happens to propose.
    if (generated.translations) {
      for (const [lang, translation] of Object.entries(generated.translations)) {
        recipe.translations.set(lang, translation);
      }
    }

    await recipe.save();
    console.log('Saved.');
  } finally {
    await require('mongoose').disconnect();
  }
}

run().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
