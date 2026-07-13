/**
 * Adds a standard set of common dietary supplements as Recipe documents
 * (category forced to 'Supplements') for the "Recipes & Supplements"
 * screen's Supplements bucket.
 *
 * Unlike food recipes, these are built DETERMINISTICALLY rather than via
 * generateRecipeWithAI - that function's prompt is tuned for "a dish with
 * 5-15 ingredients and cooking steps", so asking it to generate e.g.
 * "Multivitamin" produced an invented 6-ingredient smoothie recipe with the
 * actual multivitamin buried as one minor ingredient (confirmed by a first
 * run of this script and manually reverted). A supplement is a single
 * countable item with a known dosage, not a recipe to invent - so each one
 * here is a single-ingredient entry with the real supplement as the only
 * ingredient, and only the Hindi/Marathi translation is AI-generated (via
 * generateTranslations directly), keeping everything else exact.
 *
 * Usage:
 *   node scripts/add-supplement-recipes.js            # dry run - prints the plan, no AI calls/DB writes
 *   node scripts/add-supplement-recipes.js --execute   # actually translate + create
 */

require('dotenv').config();
const mongoose = require('mongoose');
const { generateTranslations } = require('../utils/openaiClient');

const EXECUTE = process.argv.includes('--execute');
const DIETICIAN_EMAIL = 'localdietician@dev.local';

// Each entry is a complete, ready-to-store supplement - no AI invention of
// ingredients/nutrition, just real, standard dosage/nutrition facts.
const SUPPLEMENTS = [
  {
    name: 'Multivitamin',
    description: 'A daily multivitamin tablet covering essential vitamins and minerals.',
    servingTime: 'Morning Drink',
    servingSize: { quantity: 1, unit: 'tablet' },
    ingredient: { name: 'Multivitamin Tablet', quantity: 1, unit: 'piece' },
    nutrition: { calories: 0, protein: 0, carbs: 0, fats: 0, fiber: 0 },
    instructions: ['Take one tablet with breakfast and a full glass of water.'],
  },
  {
    name: 'Omega-3 Fish Oil',
    description: 'Fish oil softgel providing EPA and DHA omega-3 fatty acids.',
    servingTime: 'Morning Drink',
    servingSize: { quantity: 1, unit: 'capsule (1000mg)' },
    ingredient: { name: 'Omega-3 Fish Oil Capsule', quantity: 1, unit: 'piece' },
    nutrition: { calories: 9, protein: 0, carbs: 0, fats: 1, fiber: 0 },
    instructions: ['Take one capsule with a meal containing some fat, for better absorption.'],
  },
  {
    name: 'Whey Protein',
    description: 'Whey protein powder scoop, commonly used post-workout to support muscle recovery.',
    servingTime: 'Brunch',
    servingSize: { quantity: 30, unit: 'g' },
    ingredient: { name: 'Whey Protein Powder', quantity: 30, unit: 'g' },
    nutrition: { calories: 126, protein: 24, carbs: 3, fats: 2, fiber: 0 },
    instructions: ['Mix one scoop with 250-300ml water or milk in a shaker.', 'Drink within 30 minutes after your workout.'],
  },
  {
    name: 'Calcium Supplement',
    description: 'Calcium tablet to support bone health.',
    servingTime: 'Night Drink',
    servingSize: { quantity: 1, unit: 'tablet (500mg)' },
    ingredient: { name: 'Calcium Tablet', quantity: 1, unit: 'piece' },
    nutrition: { calories: 0, protein: 0, carbs: 0, fats: 0, fiber: 0 },
    instructions: ['Take one tablet in the evening with water, ideally a few hours apart from iron supplements.'],
  },
  {
    name: 'Magnesium Supplement',
    description: 'Magnesium tablet commonly taken before bed to support sleep and muscle relaxation.',
    servingTime: 'Night Drink',
    servingSize: { quantity: 1, unit: 'tablet (250mg)' },
    ingredient: { name: 'Magnesium Tablet', quantity: 1, unit: 'piece' },
    nutrition: { calories: 0, protein: 0, carbs: 0, fats: 0, fiber: 0 },
    instructions: ['Take one tablet 30-60 minutes before bed with water.'],
  },
  {
    name: 'Vitamin D3 Supplement',
    description: 'Vitamin D3 softgel to support bone and immune health.',
    servingTime: 'Morning Drink',
    servingSize: { quantity: 1, unit: 'softgel (2000 IU)' },
    ingredient: { name: 'Vitamin D3 Softgel', quantity: 1, unit: 'piece' },
    nutrition: { calories: 9, protein: 0, carbs: 0, fats: 1, fiber: 0 },
    instructions: ['Take one softgel with a meal containing some fat, for best absorption.'],
  },
  {
    name: 'Vitamin C Supplement',
    description: 'Vitamin C tablet to support immune health.',
    servingTime: 'Morning Drink',
    servingSize: { quantity: 1, unit: 'tablet (500mg)' },
    ingredient: { name: 'Vitamin C Tablet', quantity: 1, unit: 'piece' },
    nutrition: { calories: 4, protein: 0, carbs: 1, fats: 0, fiber: 0 },
    instructions: ['Take one tablet with water, any time of day.'],
  },
  {
    name: 'Zinc Supplement',
    description: 'Zinc tablet to support immune function.',
    servingTime: 'Night Drink',
    servingSize: { quantity: 1, unit: 'tablet (15mg)' },
    ingredient: { name: 'Zinc Tablet', quantity: 1, unit: 'piece' },
    nutrition: { calories: 0, protein: 0, carbs: 0, fats: 0, fiber: 0 },
    instructions: ['Take one tablet away from calcium/iron supplements, with a light meal or water.'],
  },
  {
    name: 'Probiotic Supplement',
    description: 'Multi-strain probiotic capsule to support gut health.',
    servingTime: 'Morning Drink',
    servingSize: { quantity: 1, unit: 'capsule' },
    ingredient: { name: 'Probiotic Capsule', quantity: 1, unit: 'piece' },
    nutrition: { calories: 0, protein: 0, carbs: 0, fats: 0, fiber: 0 },
    instructions: ['Take one capsule on an empty stomach, first thing in the morning, with water.'],
  },
  {
    name: 'Iron Supplement',
    description: 'Iron tablet to support healthy iron levels, taken with food and vitamin C for better absorption.',
    servingTime: 'Breakfast',
    servingSize: { quantity: 1, unit: 'tablet (65mg)' },
    ingredient: { name: 'Iron Tablet', quantity: 1, unit: 'piece' },
    nutrition: { calories: 0, protein: 0, carbs: 0, fats: 0, fiber: 0 },
    instructions: ['Take one tablet with food to reduce stomach upset.', 'Pair with a source of vitamin C to aid absorption; avoid taking alongside calcium or dairy.'],
  },
  {
    name: 'Biotin Supplement',
    description: 'Biotin tablet to support hair, skin, and nail health.',
    servingTime: 'Breakfast',
    servingSize: { quantity: 1, unit: 'tablet (5000mcg)' },
    ingredient: { name: 'Biotin Tablet', quantity: 1, unit: 'piece' },
    nutrition: { calories: 0, protein: 0, carbs: 0, fats: 0, fiber: 0 },
    instructions: ['Take one tablet with breakfast and water.'],
  },
  {
    name: 'Creatine Monohydrate',
    description: 'Creatine monohydrate powder scoop to support strength and exercise performance.',
    servingTime: 'Brunch',
    servingSize: { quantity: 5, unit: 'g' },
    ingredient: { name: 'Creatine Monohydrate Powder', quantity: 5, unit: 'g' },
    nutrition: { calories: 0, protein: 0, carbs: 0, fats: 0, fiber: 0 },
    instructions: ['Mix one scoop (5g) with water or juice.', 'Can be taken any time of day - daily consistency matters more than timing.'],
  },
];

async function main() {
  console.log(EXECUTE ? '=== EXECUTING supplement import ===' : '=== DRY RUN (pass --execute to translate + create) ===');

  console.log('Connecting to MongoDB...');
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected.');

  try {
    const { User, Recipe } = require('../models');
    const dietician = await User.findOne({ email: DIETICIAN_EMAIL, role: 'dietician' });
    if (!dietician) throw new Error(`Dietician account not found: ${DIETICIAN_EMAIL}`);
    console.log(`Target dietician: ${dietician.profile?.fullName || dietician.email} (${dietician._id})`);

    const toProcess = [];
    for (const supp of SUPPLEMENTS) {
      const existing = await Recipe.findOne({
        dieticianId: dietician._id,
        name: new RegExp(`^${supp.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'),
      });
      if (existing) {
        console.log(`  [skip: already in DB] "${supp.name}"`);
        continue;
      }
      toProcess.push(supp);
    }

    console.log(`\n=== PLAN: ${toProcess.length} supplement(s) ===`);
    toProcess.forEach((s, i) => console.log(`${i + 1}. "${s.name}" [${s.servingTime}] - 1 ingredient: ${s.ingredient.name}`));

    if (!EXECUTE) {
      console.log('\nThis was a dry run - no AI calls, no DB writes. Re-run with --execute to create these.');
      return;
    }

    let created = 0;
    let failed = 0;
    for (const supp of toProcess) {
      try {
        console.log(`\nCreating: "${supp.name}"...`);

        const translations = await generateTranslations(
          {
            name: supp.name,
            description: supp.description,
            ingredients: [{ name: supp.ingredient.name, description: '' }],
            cookingSteps: supp.instructions,
            warnings: [],
          },
          ['Hindi', 'Marathi']
        );

        await Recipe.create({
          dieticianId: dietician._id,
          name: supp.name,
          category: 'Supplements',
          cuisine: 'Supplement',
          description: supp.description,
          servingTime: supp.servingTime,
          servings: 1,
          preparationTime: 1,
          cookingTime: 0,
          dietaryHabits: {},
          freeFrom: {},
          servingSize: supp.servingSize,
          ingredients: [
            {
              ...supp.ingredient,
              category: 'Other',
              priceLevel: '₹₹',
              description: supp.description,
              isScalable: false,
            },
          ],
          instructions: supp.instructions,
          nutrition: supp.nutrition,
          language: ['English', 'Hindi', 'Marathi'],
          translations,
        });

        created++;
        console.log(`  ✓ Created "${supp.name}" [Supplements]`);
      } catch (err) {
        failed++;
        console.error(`  ✗ FAILED "${supp.name}": ${err.message}`);
      }
    }

    console.log(`\n=== DONE === Created: ${created}, Failed: ${failed}`);
  } catch (error) {
    console.error('Import failed:', error);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
    console.log('Disconnected from MongoDB.');
  }
}

main();
