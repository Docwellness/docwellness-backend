/**
 * Read-only: lists every Recipe already tagged 'side' (see
 * scripts/add-side-dish-recipes.js) - used to check which accompaniment
 * recipes already exist before scripts/split-main-and-side-recipes.js
 * decides which sides it still needs to create.
 *
 * Usage: node scripts/list-side-tagged-recipes.js
 */
require('dotenv').config();
const connectDB = require('../config/database');

async function main() {
  await connectDB();
  try {
    const { Recipe } = require('../models');
    const sides = await Recipe.find({ tags: 'side' }).select('name category cuisine servingTime tags dieticianId ingredients').lean();
    console.log(`Found ${sides.length} recipe(s) tagged 'side':`);
    for (const s of sides) {
      console.log(`- [${s._id}] "${s.name}" (${s.category}/${s.cuisine}, servingTime=${s.servingTime}, dietician=${s.dieticianId}) ingredients: ${s.ingredients.map((i) => i.name).join(', ')}`);
    }
  } finally {
    await require('mongoose').disconnect();
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
