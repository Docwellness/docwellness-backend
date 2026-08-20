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
 * Usage:
 *   node scripts/seed-food-item-nutrition.js            # dry run
 *   node scripts/seed-food-item-nutrition.js --execute  # actually write
 */

require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/database');
const { FOOD_ITEM_NUTRITION_DATA } = require('./foodItemNutritionData');
const { CANONICAL_INGREDIENTS } = require('./canonical-ingredients-data');

const EXECUTE = process.argv.includes('--execute');
const normalize = (name) => name.trim().toLowerCase();

async function main() {
  console.log(EXECUTE ? '=== EXECUTING FoodItem nutrition seed ===' : '=== DRY RUN (pass --execute to write) ===');

  console.log('Connecting to MongoDB...');
  const tlsCAFile = connectDB.resolveTlsCAFile();
  const connectOptions = tlsCAFile ? { tls: true, tlsCAFile } : {};
  await mongoose.connect(process.env.MONGODB_URI, connectOptions);
  console.log('Connected.');

  try {
    const { FoodItem } = require('../models');

    const missingFromCanonicalTable = Object.keys(FOOD_ITEM_NUTRITION_DATA).filter(
      (name) => !CANONICAL_INGREDIENTS.some((c) => c.canonicalName === name)
    );
    if (missingFromCanonicalTable.length > 0) {
      console.log(`WARNING: ${missingFromCanonicalTable.length} nutrition entr(ies) have no matching CANONICAL_INGREDIENTS row (will be skipped): ${missingFromCanonicalTable.join(', ')}`);
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
    console.log(`\nPlan: ${created} to create, ${updated} to update, ${skipped.length} skipped (no nutrition data yet).`);
    if (skipped.length > 0) {
      console.log('Skipped (need a scripts/foodItemNutritionData.js entry):');
      skipped.forEach((p) => console.log(`  - ${p.name}`));
    }
    console.log(EXECUTE ? '\n=== EXECUTED ===' : '\n=== DRY RUN - pass --execute to write ===');

    if (EXECUTE) {
      const totalFoodItems = await FoodItem.countDocuments({ dataSource: 'tier1-seed' });
      console.log(`Total tier1-seed FoodItem documents now in the database: ${totalFoodItems}`);
    }
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
