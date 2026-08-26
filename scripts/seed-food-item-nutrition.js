/**
 * Loads scripts/foodItemNutritionData.js's Tier-1 nutrition table into the
 * global FoodItem collection, joined against scripts/canonical-ingredients-
 * data.js's CANONICAL_INGREDIENTS for category/unitConversions - the actual
 * data-population half of the v4.0 plan's Phase 0c prerequisite (the code
 * side, models/FoodItem.js, has existed since Phase 1; nothing had ever
 * populated it until this script).
 *
 * Idempotent: upserts by normalizedName, so re-running after adding/fixing
 * entries in foodItemNutritionData.js is always safe and never duplicates.
 * Never touches models/Ingredient.js (per-dietician image cache) - FoodItem
 * is deliberately a separate, global, dietician-independent collection, see
 * that model's own header comment.
 *
 * After this runs, re-save every existing Recipe (or run
 * scripts/backfill-recipe-versions.js) to actually resolve their
 * RecipeVersion V1 ingredients against these newly-seeded FoodItems -
 * seeding FoodItem alone does not retroactively fix an already-created
 * RecipeVersion's hasUnresolvedIngredients flag.
 *
 * Optionally also seeds prod's FoodItem collection via a second connection,
 * when explicitly asked with --prod. FoodItem carries no dieticianId (see
 * models/FoodItem.js), so unlike scripts/migrate-dev-catalog-to-prod.js
 * (which diffs dietician-scoped content against prod's existing docs for
 * that dietician), this is a plain global upsert against a second
 * connection - the same upsert-by-normalizedName logic run twice, once per
 * connection, never a diff.
 *
 * Usage:
 *   node scripts/seed-food-item-nutrition.js                    # dry run, dev only
 *   node scripts/seed-food-item-nutrition.js --execute           # write, dev only
 *   node scripts/seed-food-item-nutrition.js --execute --prod    # write, dev AND prod
 *   (--prod requires PROD_MONGODB_URI set; also honors MONGODB_TLS_CA_BASE64
 *   for prod's TLS if prod requires it - see config/database.js)
 */

require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/database');
const { FOOD_ITEM_NUTRITION_DATA } = require('./foodItemNutritionData');
const { CANONICAL_INGREDIENTS } = require('./canonical-ingredients-data');

const EXECUTE = process.argv.includes('--execute');
const PROD = process.argv.includes('--prod');
const normalize = (name) => name.trim().toLowerCase();

// Runs the same upsert-by-normalizedName plan against one FoodItem model
// (bound to either the dev connection or a second prod connection).
// Returns summary counts; never assumes which connection it was called for.
async function seedInto(FoodItem, label) {
  const missingFromCanonicalTable = Object.keys(FOOD_ITEM_NUTRITION_DATA).filter(
    (name) => !CANONICAL_INGREDIENTS.some((c) => c.canonicalName === name)
  );
  if (missingFromCanonicalTable.length > 0) {
    console.log(`[${label}] WARNING: ${missingFromCanonicalTable.length} nutrition entr(ies) have no matching CANONICAL_INGREDIENTS row (will be skipped): ${missingFromCanonicalTable.join(', ')}`);
  }

  let created = 0;
  let updated = 0;
  const plan = [];

  for (const canonical of CANONICAL_INGREDIENTS) {
    const nutrition = FOOD_ITEM_NUTRITION_DATA[canonical.canonicalName];
    if (!nutrition) {
      plan.push({ name: canonical.canonicalName, action: 'SKIP (no nutrition data)' });
      continue;
    }

    const normalizedName = normalize(canonical.canonicalName);
    const existing = await FoodItem.findOne({ normalizedName });
    const action = existing ? 'update' : 'create';
    plan.push({ name: canonical.canonicalName, action });
    if (action === 'create') created += 1;
    else updated += 1;

    if (EXECUTE) {
      await FoodItem.findOneAndUpdate(
        { normalizedName },
        {
          $set: {
            name: canonical.canonicalName,
            normalizedName,
            nutritionPer100g: nutrition,
            unitConversions: canonical.unitConversions || {},
            dataSource: 'tier1-seed',
          },
        },
        { upsert: true, returnDocument: 'after' }
      );
    }
  }

  const skipped = plan.filter((p) => p.action.startsWith('SKIP'));
  console.log(`\n[${label}] Plan: ${created} to create, ${updated} to update, ${skipped.length} skipped (no nutrition data yet).`);
  if (skipped.length > 0) {
    console.log(`[${label}] Skipped (need a scripts/foodItemNutritionData.js entry):`);
    skipped.forEach((p) => console.log(`  - ${p.name}`));
  }

  if (EXECUTE) {
    const totalFoodItems = await FoodItem.countDocuments({ dataSource: 'tier1-seed' });
    console.log(`[${label}] Total tier1-seed FoodItem documents now in the database: ${totalFoodItems}`);
  }

  return { created, updated, skipped: skipped.length };
}

async function main() {
  console.log(EXECUTE ? '=== EXECUTING FoodItem nutrition seed ===' : '=== DRY RUN (pass --execute to write) ===');

  if (PROD && !process.env.PROD_MONGODB_URI) {
    console.error('--prod was passed but PROD_MONGODB_URI is not set - refusing to guess or default this.');
    process.exitCode = 1;
    return;
  }

  console.log('Connecting to dev MongoDB...');
  const tlsCAFile = connectDB.resolveTlsCAFile();
  const connectOptions = tlsCAFile ? { tls: true, tlsCAFile } : {};
  await mongoose.connect(process.env.MONGODB_URI, connectOptions);
  console.log('Connected to dev.');

  let prodConn = null;
  try {
    const { FoodItem } = require('../models');
    await seedInto(FoodItem, 'dev');

    if (PROD) {
      console.log('\nConnecting to prod MongoDB...');
      const prodOptions = tlsCAFile ? { tls: true, tlsCAFile } : {};
      prodConn = mongoose.createConnection(process.env.PROD_MONGODB_URI, prodOptions);
      await prodConn.asPromise();
      console.log('Connected to prod.');

      const ProdFoodItem = prodConn.model('FoodItem', FoodItem.schema);
      await seedInto(ProdFoodItem, 'prod');
    }

    console.log(EXECUTE ? '\n=== EXECUTED ===' : '\n=== DRY RUN - pass --execute to write ===');
  } finally {
    if (prodConn) await prodConn.close();
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
