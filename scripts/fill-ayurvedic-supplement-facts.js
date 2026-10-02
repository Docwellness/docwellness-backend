/**
 * Fills in the real data for the 6 Ayurvedic Supplements recipes that
 * audit-recipe-missing-nutrition.js flags as missing calories, and that
 * check-supplement-facts-status.js confirms never got supplementFacts
 * filled in (unlike the other 12 Supplements recipes - see
 * update-supplement-nutrition-facts.js / translate-supplement-facts.js).
 *
 * 5 of the 6 are capsule/tablet herbal extracts, where supplementFacts
 * (active-ingredient amount, no calorie breakdown) is the right place for
 * their data - `nutrition` stays zeroed, matching every other
 * category:'Supplements' recipe. Values below are researched generic/
 * standard doses (brand: 'Generic'), NOT transcribed from a specific
 * product label - same convention as the existing Biotin Supplement /
 * Creatine Monohydrate generic entries.
 *
 * Chyawanprash is different: it's an actual food (herbal jam, 1 tsp
 * serving) with real caloric content, not just an "active ingredient" -
 * see models/Recipe.js's supplementFacts comment, which reserves that
 * field for recipes where calories/protein/carbs/fats genuinely aren't
 * the meaningful numbers. So this fills real `nutrition` for it instead,
 * scaled to a ~15g tsp serving from typical commercial Chyawanprash label
 * values (~258 kcal/100g, ~60g carbs/100g, ~0.5g protein/100g, ~0.5g
 * fat/100g, ~1g fiber/100g) - approximate, not a specific brand's lab
 * values; swap in real label numbers if/when available.
 *
 * Usage:
 *   node scripts/fill-ayurvedic-supplement-facts.js            # dry run
 *   node scripts/fill-ayurvedic-supplement-facts.js --execute  # actually write
 */

require('dns').setServers(['8.8.8.8', '1.1.1.1']);
require('dotenv').config({ quiet: true });
const mongoose = require('mongoose');

const EXECUTE = process.argv.includes('--execute');
const DIETICIAN_EMAIL = 'localdietician@dev.local';

const ZERO_NUTRITION = { calories: 0, protein: 0, carbs: 0, fats: 0, fiber: 0 };

const SUPPLEMENT_FACTS_UPDATES = [
  {
    recipeName: 'Ashwagandha Capsule',
    supplementFacts: {
      brand: 'Generic',
      servingSize: { quantity: 1, unit: 'capsule', label: '1 capsule' },
      servingsPerContainer: null,
      nutrients: [
        { name: 'Ashwagandha Root Extract (Withania somnifera, std. 5% withanolides)', amount: 500, unit: 'mg', percentNRV: null },
      ],
    },
  },
  {
    recipeName: 'Shatavari Capsule',
    supplementFacts: {
      brand: 'Generic',
      servingSize: { quantity: 1, unit: 'capsule', label: '1 capsule' },
      servingsPerContainer: null,
      nutrients: [
        { name: 'Shatavari Root Extract (Asparagus racemosus)', amount: 500, unit: 'mg', percentNRV: null },
      ],
    },
  },
  {
    recipeName: 'Brahmi Capsule',
    supplementFacts: {
      brand: 'Generic',
      servingSize: { quantity: 1, unit: 'capsule', label: '1 capsule' },
      servingsPerContainer: null,
      nutrients: [
        { name: 'Brahmi Extract (Bacopa monnieri, std. 20% bacosides)', amount: 300, unit: 'mg', percentNRV: null },
      ],
    },
  },
  {
    recipeName: 'Guduchi Giloy Tablet',
    supplementFacts: {
      brand: 'Generic',
      servingSize: { quantity: 1, unit: 'tablet', label: '1 tablet' },
      servingsPerContainer: null,
      nutrients: [
        { name: 'Giloy/Guduchi Stem Extract (Tinospora cordifolia)', amount: 500, unit: 'mg', percentNRV: null },
      ],
    },
  },
  {
    recipeName: 'Triphala Tablet',
    supplementFacts: {
      brand: 'Generic',
      servingSize: { quantity: 1, unit: 'tablet', label: '1 tablet' },
      servingsPerContainer: null,
      nutrients: [
        { name: 'Triphala (Amalaki, Haritaki, Bibhitaki blend)', amount: 500, unit: 'mg', percentNRV: null },
      ],
    },
  },
];

const NUTRITION_UPDATES = [
  {
    recipeName: 'Chyawanprash',
    // ~15g per 1 tsp serving, scaled from typical commercial label values.
    nutrition: { calories: 39, protein: 0.1, carbs: 9, fats: 0.1, fiber: 0.15 },
  },
];

async function main() {
  console.log(EXECUTE ? '=== EXECUTING Ayurvedic supplement data fill ===' : '=== DRY RUN (pass --execute to write) ===');

  const connectDB = require('../config/database');
  await connectDB();
  const { User, Recipe } = require('../models');

  const dietician = await User.findOne({ email: DIETICIAN_EMAIL, role: 'dietician' });
  if (!dietician) throw new Error(`Dietician account not found: ${DIETICIAN_EMAIL}`);
  console.log(`Target dietician: ${dietician.profile?.fullName || dietician.email} (${dietician._id})`);

  const factsPlan = [];
  const nutritionPlan = [];
  const notFound = [];

  for (const update of SUPPLEMENT_FACTS_UPDATES) {
    const recipe = await Recipe.findOne({ dieticianId: dietician._id, name: update.recipeName });
    if (!recipe) {
      notFound.push(update.recipeName);
      continue;
    }
    factsPlan.push({ recipe, update });
  }

  for (const update of NUTRITION_UPDATES) {
    const recipe = await Recipe.findOne({ dieticianId: dietician._id, name: update.recipeName });
    if (!recipe) {
      notFound.push(update.recipeName);
      continue;
    }
    nutritionPlan.push({ recipe, update });
  }

  console.log(`\n=== PLAN ===`);
  factsPlan.forEach(({ recipe, update }) => {
    console.log(`"${recipe.name}" -> supplementFacts: ${update.supplementFacts.nutrients[0].amount}${update.supplementFacts.nutrients[0].unit} ${update.supplementFacts.nutrients[0].name}, nutrition zeroed`);
  });
  nutritionPlan.forEach(({ recipe, update }) => {
    console.log(`"${recipe.name}" -> nutrition: ${JSON.stringify(update.nutrition)}`);
  });
  if (notFound.length) {
    console.log(`\nNOT FOUND in DB: ${notFound.join(', ')}`);
  }

  if (!EXECUTE) {
    console.log('\nThis was a dry run - no DB writes. Re-run with --execute to apply.');
    await mongoose.disconnect();
    return;
  }

  for (const { recipe, update } of factsPlan) {
    recipe.supplementFacts = update.supplementFacts;
    recipe.nutrition = ZERO_NUTRITION;
    await recipe.save();
    console.log(`  ✓ Updated "${recipe.name}"`);
  }
  for (const { recipe, update } of nutritionPlan) {
    recipe.nutrition = update.nutrition;
    await recipe.save();
    console.log(`  ✓ Updated "${recipe.name}"`);
  }

  console.log(`\n=== DONE === Updated: ${factsPlan.length + nutritionPlan.length}`);
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
