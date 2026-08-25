/**
 * Read-only dump of one or more recipes' full name/instructions/translations
 * (cookingSteps per language) - for manually reviewing exactly what's in a
 * recipe's steps before writing a targeted cleanup (e.g. the cross-recipe
 * contamination found by scripts/audit-cross-recipe-step-contamination.js).
 * Makes no writes.
 *
 * Usage:
 *   node scripts/dump-recipe-steps.js <recipeId> [<recipeId> ...]
 */
require('dotenv').config();
const connectDB = require('../config/database');

async function main() {
  const ids = process.argv.slice(2);
  if (ids.length === 0) {
    console.error('Usage: node scripts/dump-recipe-steps.js <recipeId> [<recipeId> ...]');
    process.exit(1);
  }

  await connectDB();
  try {
    const { Recipe } = require('../models');
    const recipes = await Recipe.find({ _id: { $in: ids } }).select('name instructions translations').lean();
    console.log(JSON.stringify(recipes, null, 2));
  } finally {
    await require('mongoose').disconnect();
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
