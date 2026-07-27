/**
 * Read-only dump of a sample of recipes (2 per servingTime slot) with full
 * ingredient lists, components, and claimed nutrition - for manually
 * cross-checking the AI-generated nutrition numbers against real-world
 * standards (USDA FoodData Central etc.). Makes no writes.
 *
 * Usage:
 *   node scripts/dumpRecipesForVerification.js [dieticianEmail]
 *   (defaults to tejasvini@docwellness.fit)
 */
require('dotenv').config();
require('dns').setServers(['8.8.8.8', '1.1.1.1']);
const mongoose = require('mongoose');

const DIETICIAN_EMAIL = process.argv[2] || 'tejasvini@docwellness.fit';
const REQUIRED_SERVING_TIMES = [
  'Morning Drink', 'Breakfast', 'Brunch', 'Lunch', 'Evening Snack', 'Dinner', 'Night Drink',
];
const SAMPLE_PER_SLOT = 2;

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);

  try {
    const { User, Recipe } = require('../models');

    const dietician = await User.findOne({ email: DIETICIAN_EMAIL, role: 'dietician' });
    if (!dietician) throw new Error(`Dietician not found: ${DIETICIAN_EMAIL}`);

    const output = {};
    for (const servingTime of REQUIRED_SERVING_TIMES) {
      const recipes = await Recipe.find({
        dieticianId: dietician._id,
        servingTime,
        category: { $ne: 'Supplements' },
      })
        .select('name servingTime category cuisine ingredients components servingSize nutrition')
        .limit(SAMPLE_PER_SLOT)
        .lean();

      output[servingTime] = recipes.map((r) => ({
        name: r.name,
        category: r.category,
        cuisine: r.cuisine,
        components: r.components || r.servingSize,
        ingredients: (r.ingredients || []).map((i) => ({
          name: i.name,
          quantity: i.quantity,
          unit: i.unit,
        })),
        claimedNutrition: r.nutrition,
      }));
    }

    console.log(JSON.stringify(output, null, 2));
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
