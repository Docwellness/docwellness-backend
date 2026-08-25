/**
 * Read-only export of all recipes (name + ingredients only) to a local JSON
 * file, for manual Viruddha Aahara / incompatible-combination auditing.
 * Makes no writes.
 *
 * Usage:
 *   node scripts/exportRecipesForAudit.js [outFile]
 *   (defaults to recipes-audit.json in the repo root)
 */
require('dotenv').config();
require('dns').setServers(['8.8.8.8', '1.1.1.1']);
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const OUT_FILE = process.argv[2] || path.join(__dirname, '..', 'recipes-audit.json');

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);

  try {
    const { Recipe } = require('../models');

    const recipes = await Recipe.find({})
      .select('name category servingTime ingredients')
      .lean();

    const output = recipes.map((r) => ({
      name: r.name,
      category: r.category,
      servingTime: r.servingTime,
      ingredients: (r.ingredients || []).map((i) => ({
        name: i.name,
        quantity: i.quantity,
        unit: i.unit,
      })),
    }));

    fs.writeFileSync(OUT_FILE, JSON.stringify(output, null, 2));
    console.log(`Wrote ${output.length} recipes to ${OUT_FILE}`);
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
