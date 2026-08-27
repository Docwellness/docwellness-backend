/**
 * Backfills `density` (g/mL) for a handful of liquid FoodItems whose
 * unitConversions only ever covered 'ml' (e.g. {"ml":1}), so switching an
 * ingredient's unit to tsp/tbsp/cup made its calorie contribution silently
 * unresolvable (services/recipeVersioningService.js's
 * resolveGramsForIngredient returns null - "never a guessed number" - when
 * neither an explicit unitConversions entry nor a density exists for the
 * requested unit) - reported as "Lemon" losing its calorie figure the
 * moment its unit was changed from 'piece' to 'tsp'.
 *
 * Paired with resolveGramsForIngredient's own new density-based fallback
 * (rawQuantity * STANDARD_VOLUME_ML[unit] * density, covering ml/tsp/tbsp/
 * cup generically) - this script supplies the one missing ingredient that
 * fallback needs: a real density value. Standard, well-documented
 * reference densities for dilute/water-based liquids, not guesses:
 *   - Water: 1.0 g/mL (exact, by definition)
 *   - Milk / Almond Milk: 1.03 g/mL (standard dairy/plant-milk density)
 *   - Lemon (this catalog's raw-ingredient name for lemon juice, per
 *     GROCERY_SHOPPING_RULE - "Lemon" not "Lemon Juice"), Amla Juice,
 *     Wheatgrass Juice: 1.03 g/mL (dilute fruit/plant juice, close to
 *     water - citrus/vegetable juice density is commonly cited in the
 *     1.03-1.05 g/mL range)
 *
 * Every other liquid FoodItem already has explicit unitConversions
 * covering tsp/tbsp/cup directly (Ghee, Oil, Honey, Coconut Milk, Soy
 * Sauce, Sesame Oil, Coconut Oil, etc. - verified before writing this
 * script) and needs no density fallback at all; this list is exactly the
 * gap found, not a blanket sweep.
 *
 * Only ever touches FoodItem.density (never nutritionPer100g/
 * unitConversions/anything else) and only sets it when currently null -
 * idempotent, safe to re-run.
 *
 * Connects via connectDB() (config/database.js), not a raw
 * mongoose.connect() - required for prod's self-hosted Mongo's custom TLS
 * CA.
 *
 * Usage:
 *   node scripts/backfill-liquid-density.js              # dry run
 *   node scripts/backfill-liquid-density.js --execute     # write
 */
require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/database');

const EXECUTE = process.argv.includes('--execute');

const DENSITY_BY_NAME = {
  Water: 1.0,
  Milk: 1.03,
  'Almond Milk': 1.03,
  Lemon: 1.03,
  'Amla Juice': 1.03,
  'Wheatgrass Juice': 1.03,
};

async function main() {
  console.log(EXECUTE ? '=== EXECUTING liquid density backfill ===' : '=== DRY RUN (pass --execute to write) ===');
  console.log('Connecting to MongoDB...');
  await connectDB();
  console.log('Connected.');

  try {
    const { FoodItem } = require('../models');

    const names = Object.keys(DENSITY_BY_NAME);
    const items = await FoodItem.find({ name: { $in: names } });
    console.log(`Found ${items.length}/${names.length} named FoodItems.\n`);
    names.filter((n) => !items.some((i) => i.name === n)).forEach((n) => console.log(`NOT FOUND (skipping): "${n}"`));

    let updated = 0;
    let skipped = 0;
    let failed = 0;

    for (const item of items) {
      if (typeof item.density === 'number') {
        console.log(`SKIP (already has density=${item.density}): "${item.name}"`);
        skipped++;
        continue;
      }

      const density = DENSITY_BY_NAME[item.name];
      console.log(`"${item.name}" density: null -> ${density}`);

      if (EXECUTE) {
        try {
          item.density = density;
          await item.save();
          updated++;
        } catch (err) {
          console.error(`  FAILED to save "${item.name}": ${err.message}`);
          failed++;
        }
      }
    }

    console.log(`\n=== ${EXECUTE ? 'DONE' : 'DRY RUN DONE'} === total=${items.length} updated=${updated} skipped=${skipped} failed=${failed}`);
  } finally {
    await mongoose.disconnect();
    console.log('Disconnected from MongoDB.');
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
