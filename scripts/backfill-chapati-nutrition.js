/**
 * Sets FoodItem "Chapati"'s nutritionPer100g and its piece-to-grams
 * conversion to a standard plain whole-wheat roti reference (1 piece =
 * 40g, ~260 kcal/100g -> ~104 kcal per piece) - the "Chapati must always be
 * a handful size for 1, find calories for it" fix. Only fills currently-
 * null nutritionPer100g fields (never overwrites an already-populated
 * figure with this estimate); unitConversions.piece is always set/
 * overwritten, since "1 piece = handful size" is meant to be the
 * authoritative convention going forward, not just a gap-filler.
 *
 * ALWAYS dry-run first (default) and read the diff before passing --execute.
 *
 * Usage:
 *   node scripts/backfill-chapati-nutrition.js            # dry run
 *   node scripts/backfill-chapati-nutrition.js --execute  # actually write
 */
require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/database');
const { normalize } = require('../utils/ingredientLibrary');

const EXECUTE = process.argv.includes('--execute');

// Standard plain whole-wheat chapati/roti reference values, per 100g -
// broadly consistent with common Indian nutrition-database figures for an
// unoiled roti (e.g. ~71 kcal for a ~30g roti, ~104 kcal for a 40g one).
const REFERENCE_NUTRITION_PER_100G = {
  calories: 260,
  protein: 7.5,
  carbs: 50,
  fats: 4,
  fiber: 4.5,
};
const REFERENCE_PIECE_GRAMS = 40; // "1 piece" = one handful-size chapati

async function run() {
  // Never mongoose.connect(uri) directly here - prod's self-hosted Mongo
  // needs the custom CA file connectDB() builds from MONGODB_TLS_CA_BASE64
  // (see config/database.js's own comment); without it this fails with a
  // misleading "self-signed certificate in certificate chain" error.
  await connectDB();
  try {
    const { FoodItem } = require('../models');

    const chapati = await FoodItem.findOne({ normalizedName: normalize('Chapati') });
    if (!chapati) {
      console.log('No FoodItem named "Chapati" found - nothing to do. (Check spelling/normalizedName if this is unexpected.)');
      return;
    }

    const before = chapati.toObject();
    const nutritionUpdates = {};
    for (const [field, value] of Object.entries(REFERENCE_NUTRITION_PER_100G)) {
      if (typeof before.nutritionPer100g?.[field] !== 'number') {
        nutritionUpdates[field] = value;
      }
    }
    const pieceConversionChanged = before.unitConversions?.piece !== REFERENCE_PIECE_GRAMS;

    console.log(`FoodItem: ${chapati.name} (${chapati._id})`);
    console.log('Current nutritionPer100g:', before.nutritionPer100g);
    console.log('Fields to fill (currently null only):', nutritionUpdates);
    console.log(`Current unitConversions.piece: ${before.unitConversions?.piece ?? null} -> ${REFERENCE_PIECE_GRAMS}`);

    if (Object.keys(nutritionUpdates).length === 0 && !pieceConversionChanged) {
      console.log('Nothing to change - already fully set.');
      return;
    }

    if (!EXECUTE) {
      console.log('\nDry run only - pass --execute to apply.');
      return;
    }

    for (const [field, value] of Object.entries(nutritionUpdates)) {
      chapati.nutritionPer100g[field] = value;
    }
    chapati.unitConversions = chapati.unitConversions || {};
    chapati.unitConversions.piece = REFERENCE_PIECE_GRAMS;
    await chapati.save();
    console.log('Saved.');
  } finally {
    await mongoose.disconnect();
  }
}

run().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
