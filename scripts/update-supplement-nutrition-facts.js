/**
 * Replaces the placeholder macro `nutrition` on the existing generic
 * Supplements recipes (from add-supplement-recipes.js) with real
 * `supplementFacts` transcribed from actual product labels - see
 * C:\Users\bhush\Downloads\supplements. A vitamin/mineral tablet's
 * meaningful numbers are its active-ingredient amounts and %NRV, not
 * calories/protein/carbs/fats, so `nutrition` is zeroed out here and the
 * real data moves to `supplementFacts` (see models/Recipe.js).
 *
 * Matches by exact recipe name (same lookup style as add-supplement-
 * recipes.js) and only updates recipes that already exist - it does not
 * create new ones. Two generics with no real-product label available
 * (Biotin Supplement, Creatine Monohydrate) are intentionally left alone.
 *
 * Usage:
 *   node scripts/update-supplement-nutrition-facts.js            # dry run
 *   node scripts/update-supplement-nutrition-facts.js --execute  # actually write
 */

require('dotenv').config();
const mongoose = require('mongoose');

const EXECUTE = process.argv.includes('--execute');
const DIETICIAN_EMAIL = 'localdietician@dev.local';

const ZERO_NUTRITION = { calories: 0, protein: 0, carbs: 0, fats: 0, fiber: 0 };

// Each entry: which existing recipe (by name) gets which real product's facts.
const UPDATES = [
  {
    recipeName: 'Multivitamin',
    supplementFacts: {
      brand: 'Doppelherz A-Z Depot',
      servingSize: { quantity: 1, unit: 'tablet', label: '1 Tablette' },
      servingsPerContainer: 120,
      nutrients: [
        { name: 'Vitamin A', amount: 400, unit: 'µg RE', percentNRV: 50 },
        { name: 'Lutein', amount: 1500, unit: 'µg', percentNRV: null },
        { name: 'Vitamin D', amount: 5, unit: 'µg', percentNRV: 100 },
        { name: 'Vitamin E', amount: 10, unit: 'mg α-TE', percentNRV: 83 },
        { name: 'Vitamin K', amount: 20, unit: 'µg', percentNRV: 27 },
        { name: 'Vitamin C', amount: 150, unit: 'mg', percentNRV: 188 },
        { name: 'Vitamin B1', amount: 3.5, unit: 'mg', percentNRV: 318 },
        { name: 'Vitamin B2', amount: 4.0, unit: 'mg', percentNRV: 286 },
        { name: 'Niacin', amount: 18, unit: 'mg NE', percentNRV: 113 },
        { name: 'Vitamin B6', amount: 5.0, unit: 'mg', percentNRV: 357 },
        { name: 'Folsäure', amount: 450, unit: 'µg', percentNRV: 225 },
        { name: 'Vitamin B12', amount: 2.5, unit: 'µg', percentNRV: 100 },
        { name: 'Biotin', amount: 300, unit: 'µg', percentNRV: 600 },
        { name: 'Pantothensäure', amount: 12, unit: 'mg', percentNRV: 200 },
        { name: 'Calcium', amount: 140, unit: 'mg', percentNRV: 18 },
        { name: 'Phosphor', amount: 105, unit: 'mg', percentNRV: 15 },
        { name: 'Magnesium', amount: 56.3, unit: 'mg', percentNRV: 15 },
        { name: 'Eisen', amount: 2.1, unit: 'mg', percentNRV: 15 },
        { name: 'Zink', amount: 5, unit: 'mg', percentNRV: 50 },
        { name: 'Kupfer', amount: 0.9, unit: 'mg', percentNRV: 90 },
        { name: 'Selen', amount: 10, unit: 'µg', percentNRV: 18 },
        { name: 'Chrom', amount: 25, unit: 'µg', percentNRV: 63 },
        { name: 'Molybdän', amount: 20, unit: 'µg', percentNRV: 40 },
        { name: 'Jod', amount: 100, unit: 'µg', percentNRV: 67 },
      ],
    },
  },
  {
    recipeName: 'Omega-3 Fish Oil',
    supplementFacts: {
      brand: 'Doppelherz aktiv Omega-3 1400',
      servingSize: { quantity: 1, unit: 'capsule', label: '1 Kapsel' },
      servingsPerContainer: 90,
      nutrients: [
        { name: 'Fischölkonzentrat aus Seefischöl', amount: 1400, unit: 'mg', percentNRV: null },
        { name: 'Omega-3-Fettsäuren insgesamt', amount: 485, unit: 'mg', percentNRV: null },
        { name: 'Eicosapentaensäure (EPA)', amount: 285, unit: 'mg', percentNRV: null },
        { name: 'Docosahexaensäure (DHA)', amount: 190, unit: 'mg', percentNRV: null },
        { name: 'Vitamin E', amount: 20, unit: 'mg α-TE', percentNRV: 167 },
      ],
    },
  },
  {
    recipeName: 'Whey Protein',
    supplementFacts: {
      brand: 'Myprotein Impact Whey Isolate',
      servingSize: { quantity: 25, unit: 'g', label: '1 Messlöffel (25 g)' },
      servingsPerContainer: 40,
      nutrients: [
        { name: 'Energie', amount: 93, unit: 'kcal', percentNRV: null },
        { name: 'Fett', amount: 0.1, unit: 'g', percentNRV: null },
        { name: 'davon gesättigte Fettsäuren', amount: 0.1, unit: 'g', percentNRV: null },
        { name: 'Kohlenhydrate', amount: 0.6, unit: 'g', percentNRV: null },
        { name: 'davon Zucker', amount: 0.6, unit: 'g', percentNRV: null },
        { name: 'Protein', amount: 23, unit: 'g', percentNRV: null },
        { name: 'Salz', amount: 0.13, unit: 'g', percentNRV: null },
      ],
    },
  },
  {
    recipeName: 'Calcium Supplement',
    supplementFacts: {
      brand: 'Mivolis Calcium + D3',
      servingSize: { quantity: 1, unit: 'tablet', label: '1 Tablette' },
      servingsPerContainer: 300,
      nutrients: [
        { name: 'Calcium', amount: 267, unit: 'mg', percentNRV: 33 },
        { name: 'Vitamin D3', amount: 1.7, unit: 'µg', percentNRV: 33 },
      ],
    },
  },
  {
    recipeName: 'Magnesium Supplement',
    supplementFacts: {
      brand: 'Mivolis Magnesium 400',
      servingSize: { quantity: 1, unit: 'tablet', label: '1 Tablette (= dnevna doza)' },
      servingsPerContainer: 60,
      nutrients: [{ name: 'Magnesium', amount: 400, unit: 'mg', percentNRV: 107 }],
    },
  },
  {
    recipeName: 'Vitamin D3 Supplement',
    supplementFacts: {
      brand: 'Doppelherz aktiv Vitamin D3 2000 I.E.',
      servingSize: { quantity: 1, unit: 'tablet', label: '1 Tablette' },
      servingsPerContainer: 50,
      nutrients: [{ name: 'Vitamin D', amount: 50, unit: 'µg', percentNRV: 1000 }],
    },
  },
  {
    recipeName: 'Vitamin C Supplement',
    supplementFacts: {
      brand: 'Mivolis Vitamin C Depot',
      servingSize: { quantity: 1, unit: 'capsule', label: '1 Kapsel' },
      servingsPerContainer: 40,
      nutrients: [{ name: 'Vitamin C', amount: 300, unit: 'mg', percentNRV: 375 }],
    },
  },
  {
    recipeName: 'Zinc Supplement',
    supplementFacts: {
      brand: 'Mivolis Zink 15 + Histidin + Cystein',
      servingSize: { quantity: 1, unit: 'tablet', label: '1 Tablette (= dnevna doza)' },
      servingsPerContainer: 40,
      nutrients: [
        { name: 'Zink', amount: 15, unit: 'mg', percentNRV: 150 },
        { name: 'L-Histidin', amount: 100, unit: 'mg', percentNRV: null },
        { name: 'L-Cystein', amount: 19, unit: 'mg', percentNRV: null },
      ],
    },
  },
  {
    recipeName: 'Probiotic Supplement',
    supplementFacts: {
      brand: 'Mivolis Darm Plus',
      servingSize: { quantity: 1, unit: 'capsule', label: '1 Kapsel' },
      servingsPerContainer: 30,
      nutrients: [
        { name: 'Milchsäurebakterien', amount: 10, unit: 'x10^9 AFU', percentNRV: null },
        { name: 'Inulin', amount: 172.8, unit: 'mg', percentNRV: null },
        { name: 'Niacin', amount: 3.0, unit: 'mg NE', percentNRV: 18.75 },
        { name: 'Vitamin B2', amount: 0.44, unit: 'mg', percentNRV: 31 },
        { name: 'Vitamin B6', amount: 0.44, unit: 'mg', percentNRV: 31 },
        { name: 'Vitamin B1', amount: 0.35, unit: 'mg', percentNRV: 32 },
        { name: 'Folsäure', amount: 60, unit: 'µg', percentNRV: 30 },
        { name: 'Biotin', amount: 14, unit: 'µg', percentNRV: 28 },
      ],
    },
  },
  {
    recipeName: 'Iron Supplement',
    supplementFacts: {
      brand: 'Mivolis Eisen + C + B-Vitamine',
      servingSize: { quantity: 1, unit: 'tablet', label: '1 Tablette' },
      servingsPerContainer: 40,
      nutrients: [
        { name: 'Eisen', amount: 14, unit: 'mg', percentNRV: 100 },
        { name: 'Vitamin C', amount: 180, unit: 'mg', percentNRV: 225 },
        { name: 'Folsäure', amount: 200, unit: 'µg', percentNRV: 100 },
        { name: 'Vitamin B6', amount: 4.5, unit: 'mg', percentNRV: 321 },
        { name: 'Vitamin B12', amount: 3.0, unit: 'µg', percentNRV: 120 },
      ],
    },
  },
  {
    recipeName: 'Triphala Night Drink',
    supplementFacts: {
      brand: 'Bio Triphala Churna (Amalaki, Haritaki, Bibhitaki)',
      servingSize: { quantity: 3, unit: 'g', label: '~3 g Triphala-Pulver in warmem Wasser' },
      servingsPerContainer: null,
      nutrients: [
        { name: 'Energie', amount: 8.61, unit: 'kcal', percentNRV: 0.43 },
        { name: 'Fett', amount: 0.02, unit: 'g', percentNRV: 0.03 },
        { name: 'davon gesättigte Fettsäuren', amount: 0.01, unit: 'g', percentNRV: 0.03 },
        { name: 'Kohlenhydrate', amount: 1.38, unit: 'g', percentNRV: 0.53 },
        { name: 'davon Zucker', amount: 0.30, unit: 'g', percentNRV: 0.33 },
        { name: 'Eiweiß', amount: 0.12, unit: 'g', percentNRV: 0.23 },
        { name: 'Salz', amount: 0.03, unit: 'g', percentNRV: 0.45 },
      ],
    },
  },
];

async function main() {
  console.log(EXECUTE ? '=== EXECUTING supplement facts update ===' : '=== DRY RUN (pass --execute to write) ===');

  console.log('Connecting to MongoDB...');
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected.');

  try {
    const { User, Recipe } = require('../models');
    const dietician = await User.findOne({ email: DIETICIAN_EMAIL, role: 'dietician' });
    if (!dietician) throw new Error(`Dietician account not found: ${DIETICIAN_EMAIL}`);
    console.log(`Target dietician: ${dietician.profile?.fullName || dietician.email} (${dietician._id})`);

    const toProcess = [];
    for (const update of UPDATES) {
      const existing = await Recipe.findOne({
        dieticianId: dietician._id,
        name: new RegExp(`^${update.recipeName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'),
      });
      if (!existing) {
        console.log(`  [skip: not found in DB] "${update.recipeName}"`);
        continue;
      }
      toProcess.push({ recipe: existing, update });
    }

    console.log(`\n=== PLAN: ${toProcess.length} recipe(s) ===`);
    toProcess.forEach(({ recipe, update }, i) => {
      console.log(
        `${i + 1}. "${recipe.name}" -> brand "${update.supplementFacts.brand}", ${update.supplementFacts.nutrients.length} nutrient(s), nutrition zeroed`
      );
    });

    if (!EXECUTE) {
      console.log('\nThis was a dry run - no DB writes. Re-run with --execute to apply.');
      return;
    }

    let updated = 0;
    for (const { recipe, update } of toProcess) {
      recipe.supplementFacts = update.supplementFacts;
      recipe.nutrition = ZERO_NUTRITION;
      await recipe.save();
      updated++;
      console.log(`  ✓ Updated "${recipe.name}"`);
    }

    console.log(`\n=== DONE === Updated: ${updated}`);
  } catch (error) {
    console.error('Update failed:', error);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
    console.log('Disconnected from MongoDB.');
  }
}

main();
