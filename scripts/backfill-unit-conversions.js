/**
 * Fills the 2 real unit-conversion gaps found by
 * scripts/audit-fooditem-nutrition-coverage.js against prod: "Almonds"
 * (unit 'nos', used in Warm Water with Dates/Figs/Almonds/Walnuts and Oats
 * Porridge) and "Brown Bread" (unit 'slice', used in Boiled Eggs with Brown
 * Bread and Avocado Sandwich and Peanut Butter on Brown Bread). Both
 * FoodItems already have complete nutritionPer100g (confirmed by the
 * audit's incompleteNutritionCount: 0) - this only adds the missing
 * unitConversions entry, using standard reference weights (1 almond ≈
 * 1.2g; 1 slice of bread ≈ 28g). Never overwrites an existing conversion
 * for that unit if one somehow already exists.
 *
 * ALWAYS dry-run first (default) and read the diff before passing --execute.
 *
 * Usage:
 *   node scripts/backfill-unit-conversions.js            # dry run
 *   node scripts/backfill-unit-conversions.js --execute  # actually write
 */
require('dotenv').config();
const connectDB = require('../config/database');
const { normalize } = require('../utils/ingredientLibrary');

const EXECUTE = process.argv.includes('--execute');

const FIXES = [
  { name: 'Almonds', unit: 'nos', gramsPerUnit: 1.2 },
  { name: 'Brown Bread', unit: 'slice', gramsPerUnit: 28 },
];

async function run() {
  await connectDB();
  try {
    const { FoodItem } = require('../models');

    for (const fix of FIXES) {
      const foodItem = await FoodItem.findOne({ normalizedName: normalize(fix.name) });
      if (!foodItem) {
        console.log(`No FoodItem named "${fix.name}" found - skipping.`);
        continue;
      }

      const current = foodItem.unitConversions?.[fix.unit];
      console.log(`${foodItem.name} (${foodItem._id}): unitConversions.${fix.unit} ${current ?? 'null'} -> ${fix.gramsPerUnit}`);

      if (typeof current === 'number') {
        console.log(`  Already set - leaving as-is.`);
        continue;
      }

      if (!EXECUTE) continue;

      foodItem.unitConversions = foodItem.unitConversions || {};
      foodItem.unitConversions[fix.unit] = fix.gramsPerUnit;
      await foodItem.save();
      console.log('  Saved.');
    }

    if (!EXECUTE) console.log('\nDry run only - pass --execute to apply.');
  } finally {
    await require('mongoose').disconnect();
  }
}

run().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
