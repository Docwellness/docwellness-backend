/**
 * Read-only recipe export for openspec/changes/fill-recipe-micronutrients
 * (design.md Decision 10, task 6b.1). Meant to be run by the user against
 * prod in a Coolify terminal; the output is then used for the per-recipe
 * micronutrient cross-check. Makes no document writes (find/lean only) and
 * prints no connection string or .env value. connectDB() may touch indexes
 * (dropStaleUsernameIndex; syncIndexesOnBoot when SYNC_INDEXES_ON_BOOT=true;
 * Mongoose autoIndex): index/metadata operations, not document writes.
 * Before running on prod, confirm SYNC_INDEXES_ON_BOOT is unset there.
 *
 * Exports, per recipe: _id, name, category, servingTime, servings,
 * servingSize, components, ingredients (name/quantity/unit), current
 * `nutrition` and `nutritionPerServing`, and the dietician-verified flag.
 * Recipe catalog data only: no patient, PlanItem or user data (dieticianId
 * is deliberately not exported).
 *
 * The Recipe schema has no dedicated verified field today, so `verified` is
 * read from `isVerified` / `verified` if a document carries one, else null
 * (unknown). `summary.recipesWithVerifiedFlag` says how many documents had
 * one, so a null-everywhere result is visible rather than silently "false".
 *
 * Usage:
 *   node scripts/export-recipes-prod.js [outFile] [--require-local]
 *   (outFile defaults to .cache/recipes-export-<timestamp>.json, a
 *   git-ignored path; keep it out of version control either way)
 *   --require-local aborts before connecting unless MONGODB_URI points at
 *   localhost / 127.0.0.1 (use it for staging test runs).
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const connectDB = require('../config/database');

const args = process.argv.slice(2);
const REQUIRE_LOCAL = args.includes('--require-local');
const outArg = args.find((arg) => !arg.startsWith('--'));

const DEFAULT_OUT_FILE = () =>
  path.join(__dirname, '..', '.cache', `recipes-export-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);

// Parses only the host out of the URI, never prints it. Fails closed.
function assertLocalTarget() {
  const uri = process.env.MONGODB_URI || '';
  const hostList = uri.replace(/^mongodb(\+srv)?:\/\//, '').replace(/^[^@/]*@/, '').split(/[/?]/)[0];
  const hosts = hostList.split(',').map((h) => h.replace(/:\d+$/, ''));
  const isLocal = !uri.startsWith('mongodb+srv://') && hosts.length > 0 && hosts.every((h) => h === 'localhost' || h === '127.0.0.1');
  if (!isLocal) {
    console.error('ABORT: --require-local was given but MONGODB_URI does not point at localhost. Nothing was connected.');
    process.exit(2);
  }
}

const verifiedFlagOf = (recipe) => recipe.isVerified ?? recipe.verified ?? null;

async function main() {
  if (REQUIRE_LOCAL) assertLocalTarget();

  // Never mongoose.connect(uri) directly - prod needs the private-CA TLS
  // options connectDB() builds (see config/database.js).
  await connectDB();

  try {
    const { Recipe } = require('../models');

    const recipes = await Recipe.find({})
      .select('name category servingTime servings servingSize components ingredients nutrition nutritionPerServing isVerified verified status')
      .lean();

    const output = recipes.map((r) => ({
      _id: String(r._id),
      name: r.name,
      category: r.category,
      servingTime: r.servingTime,
      status: r.status,
      servings: r.servings,
      servingSize: r.servingSize || null,
      components: r.components || null,
      ingredients: (r.ingredients || []).map((i) => ({
        name: i.name,
        quantity: i.quantity,
        unit: i.unit,
      })),
      nutrition: r.nutrition || null,
      nutritionPerServing: r.nutritionPerServing || null,
      verified: verifiedFlagOf(r),
    }));

    const summary = {
      totalRecipes: output.length,
      recipesWithVerifiedFlag: output.filter((r) => r.verified !== null).length,
      recipesVerifiedTrue: output.filter((r) => r.verified === true).length,
    };

    const outFile = outArg || DEFAULT_OUT_FILE();
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, JSON.stringify({ generatedAt: new Date().toISOString(), summary, recipes: output }, null, 2));
    console.log(`Wrote ${output.length} recipes to ${outFile}`);
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error('FATAL:', err.message);
  process.exit(1);
});
