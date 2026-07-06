/**
 * Seed dummy MealLog data for patient 69982ebe1340daa0c9d84cc2
 * for testing charts (This Week / This Month / This Year)
 *
 * Run: node seed-dummy-meallogs.js
 */

const mongoose = require('mongoose');
require('dotenv').config();

// Connect
const MONGO_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/docwellness';

async function run() {
  await mongoose.connect(MONGO_URI);
  console.log('Connected to MongoDB');

  const MealLog = require('./models/MealLog');
  const patientId = new mongoose.Types.ObjectId('69982ebe1340daa0c9d84cc2');

  // Helper: create a date at midnight local time
  function localDate(year, month, day) {
    return new Date(year, month - 1, day, 0, 0, 0, 0);
  }

  // ---- DATA TO INSERT ----
  // Today is Sat Feb 21, 2026
  // This week: Mon Feb 16 - Sun Feb 22
  const entries = [
    // --- THIS WEEK (Mon-Sat) ---
    {
      date: localDate(2026, 2, 16),
      totalCalories: 1850,
      meals: [
        { mealType: 'Breakfast', servingTime: 'Breakfast', caloriesConsumed: 450, servings: 1 },
        { mealType: 'Lunch', servingTime: 'Lunch', caloriesConsumed: 650, servings: 1 },
        {
          mealType: 'Evening Snack',
          servingTime: 'Evening Snack',
          caloriesConsumed: 200,
          servings: 1,
        },
        { mealType: 'Dinner', servingTime: 'Dinner', caloriesConsumed: 550, servings: 1 },
      ],
    },
    {
      date: localDate(2026, 2, 17),
      totalCalories: 2100,
      meals: [
        { mealType: 'Breakfast', servingTime: 'Breakfast', caloriesConsumed: 500, servings: 1 },
        { mealType: 'Lunch', servingTime: 'Lunch', caloriesConsumed: 700, servings: 1 },
        {
          mealType: 'Evening Snack',
          servingTime: 'Evening Snack',
          caloriesConsumed: 300,
          servings: 1,
        },
        { mealType: 'Dinner', servingTime: 'Dinner', caloriesConsumed: 600, servings: 1 },
      ],
    },
    {
      date: localDate(2026, 2, 18),
      totalCalories: 1600,
      meals: [
        { mealType: 'Breakfast', servingTime: 'Breakfast', caloriesConsumed: 400, servings: 1 },
        { mealType: 'Lunch', servingTime: 'Lunch', caloriesConsumed: 550, servings: 1 },
        { mealType: 'Dinner', servingTime: 'Dinner', caloriesConsumed: 650, servings: 1 },
      ],
    },
    {
      date: localDate(2026, 2, 19),
      totalCalories: 2350,
      meals: [
        { mealType: 'Breakfast', servingTime: 'Breakfast', caloriesConsumed: 550, servings: 1 },
        { mealType: 'Brunch', servingTime: 'Brunch', caloriesConsumed: 350, servings: 1 },
        { mealType: 'Lunch', servingTime: 'Lunch', caloriesConsumed: 650, servings: 1 },
        {
          mealType: 'Evening Snack',
          servingTime: 'Evening Snack',
          caloriesConsumed: 250,
          servings: 1,
        },
        { mealType: 'Dinner', servingTime: 'Dinner', caloriesConsumed: 550, servings: 1 },
      ],
    },
    {
      date: localDate(2026, 2, 20),
      totalCalories: 1950,
      meals: [
        { mealType: 'Breakfast', servingTime: 'Breakfast', caloriesConsumed: 480, servings: 1 },
        { mealType: 'Lunch', servingTime: 'Lunch', caloriesConsumed: 620, servings: 1 },
        {
          mealType: 'Evening Snack',
          servingTime: 'Evening Snack',
          caloriesConsumed: 200,
          servings: 1,
        },
        { mealType: 'Dinner', servingTime: 'Dinner', caloriesConsumed: 650, servings: 1 },
      ],
    },
    {
      date: localDate(2026, 2, 21),
      totalCalories: 1200,
      meals: [
        { mealType: 'Breakfast', servingTime: 'Breakfast', caloriesConsumed: 500, servings: 1 },
        { mealType: 'Lunch', servingTime: 'Lunch', caloriesConsumed: 700, servings: 1 },
      ],
    },

    // --- EARLIER THIS MONTH (Week 1 & 2 of Feb) ---
    {
      date: localDate(2026, 2, 2),
      totalCalories: 1700,
      meals: [
        { mealType: 'Breakfast', servingTime: 'Breakfast', caloriesConsumed: 400, servings: 1 },
        { mealType: 'Lunch', servingTime: 'Lunch', caloriesConsumed: 600, servings: 1 },
        { mealType: 'Dinner', servingTime: 'Dinner', caloriesConsumed: 700, servings: 1 },
      ],
    },
    {
      date: localDate(2026, 2, 3),
      totalCalories: 2000,
      meals: [
        { mealType: 'Breakfast', servingTime: 'Breakfast', caloriesConsumed: 500, servings: 1 },
        { mealType: 'Lunch', servingTime: 'Lunch', caloriesConsumed: 700, servings: 1 },
        { mealType: 'Dinner', servingTime: 'Dinner', caloriesConsumed: 800, servings: 1 },
      ],
    },
    {
      date: localDate(2026, 2, 5),
      totalCalories: 1550,
      meals: [
        { mealType: 'Breakfast', servingTime: 'Breakfast', caloriesConsumed: 350, servings: 1 },
        { mealType: 'Lunch', servingTime: 'Lunch', caloriesConsumed: 600, servings: 1 },
        { mealType: 'Dinner', servingTime: 'Dinner', caloriesConsumed: 600, servings: 1 },
      ],
    },
    {
      date: localDate(2026, 2, 9),
      totalCalories: 1800,
      meals: [
        { mealType: 'Breakfast', servingTime: 'Breakfast', caloriesConsumed: 450, servings: 1 },
        { mealType: 'Lunch', servingTime: 'Lunch', caloriesConsumed: 650, servings: 1 },
        { mealType: 'Dinner', servingTime: 'Dinner', caloriesConsumed: 700, servings: 1 },
      ],
    },
    {
      date: localDate(2026, 2, 10),
      totalCalories: 2200,
      meals: [
        { mealType: 'Breakfast', servingTime: 'Breakfast', caloriesConsumed: 550, servings: 1 },
        { mealType: 'Lunch', servingTime: 'Lunch', caloriesConsumed: 750, servings: 1 },
        {
          mealType: 'Evening Snack',
          servingTime: 'Evening Snack',
          caloriesConsumed: 300,
          servings: 1,
        },
        { mealType: 'Dinner', servingTime: 'Dinner', caloriesConsumed: 600, servings: 1 },
      ],
    },
    {
      date: localDate(2026, 2, 12),
      totalCalories: 1900,
      meals: [
        { mealType: 'Breakfast', servingTime: 'Breakfast', caloriesConsumed: 500, servings: 1 },
        { mealType: 'Lunch', servingTime: 'Lunch', caloriesConsumed: 650, servings: 1 },
        { mealType: 'Dinner', servingTime: 'Dinner', caloriesConsumed: 750, servings: 1 },
      ],
    },
    {
      date: localDate(2026, 2, 14),
      totalCalories: 2050,
      meals: [
        { mealType: 'Breakfast', servingTime: 'Breakfast', caloriesConsumed: 480, servings: 1 },
        { mealType: 'Lunch', servingTime: 'Lunch', caloriesConsumed: 700, servings: 1 },
        {
          mealType: 'Evening Snack',
          servingTime: 'Evening Snack',
          caloriesConsumed: 270,
          servings: 1,
        },
        { mealType: 'Dinner', servingTime: 'Dinner', caloriesConsumed: 600, servings: 1 },
      ],
    },

    // --- LAST MONTH (Jan 2026) ---
    {
      date: localDate(2026, 1, 5),
      totalCalories: 1750,
      meals: [
        { mealType: 'Breakfast', servingTime: 'Breakfast', caloriesConsumed: 400, servings: 1 },
        { mealType: 'Lunch', servingTime: 'Lunch', caloriesConsumed: 650, servings: 1 },
        { mealType: 'Dinner', servingTime: 'Dinner', caloriesConsumed: 700, servings: 1 },
      ],
    },
    {
      date: localDate(2026, 1, 10),
      totalCalories: 2100,
      meals: [
        { mealType: 'Breakfast', servingTime: 'Breakfast', caloriesConsumed: 550, servings: 1 },
        { mealType: 'Lunch', servingTime: 'Lunch', caloriesConsumed: 700, servings: 1 },
        { mealType: 'Dinner', servingTime: 'Dinner', caloriesConsumed: 850, servings: 1 },
      ],
    },
    {
      date: localDate(2026, 1, 15),
      totalCalories: 1600,
      meals: [
        { mealType: 'Breakfast', servingTime: 'Breakfast', caloriesConsumed: 380, servings: 1 },
        { mealType: 'Lunch', servingTime: 'Lunch', caloriesConsumed: 620, servings: 1 },
        { mealType: 'Dinner', servingTime: 'Dinner', caloriesConsumed: 600, servings: 1 },
      ],
    },
    {
      date: localDate(2026, 1, 20),
      totalCalories: 1950,
      meals: [
        { mealType: 'Breakfast', servingTime: 'Breakfast', caloriesConsumed: 500, servings: 1 },
        { mealType: 'Lunch', servingTime: 'Lunch', caloriesConsumed: 700, servings: 1 },
        { mealType: 'Dinner', servingTime: 'Dinner', caloriesConsumed: 750, servings: 1 },
      ],
    },
    {
      date: localDate(2026, 1, 25),
      totalCalories: 2300,
      meals: [
        { mealType: 'Breakfast', servingTime: 'Breakfast', caloriesConsumed: 600, servings: 1 },
        { mealType: 'Lunch', servingTime: 'Lunch', caloriesConsumed: 800, servings: 1 },
        {
          mealType: 'Evening Snack',
          servingTime: 'Evening Snack',
          caloriesConsumed: 300,
          servings: 1,
        },
        { mealType: 'Dinner', servingTime: 'Dinner', caloriesConsumed: 600, servings: 1 },
      ],
    },
  ];

  // Delete matching dates to avoid duplicates
  for (const entry of entries) {
    const dayStart = new Date(entry.date);
    const dayEnd = new Date(entry.date);
    dayEnd.setDate(dayEnd.getDate() + 1);

    await MealLog.deleteMany({
      patientId,
      date: { $gte: dayStart, $lt: dayEnd },
    });
  }

  console.log('Cleared existing logs for target dates');

  // Insert all entries
  const docs = entries.map((e) => ({
    patientId,
    date: e.date,
    meals: e.meals,
    totalCalories: e.totalCalories,
  }));

  await MealLog.insertMany(docs);
  console.log(`Inserted ${docs.length} MealLog entries`);

  // Summary
  console.log('\n--- Summary ---');
  console.log(`This week (Mon-Sat): 6 entries (Feb 16-21)`);
  console.log(`Earlier this month:  7 entries (Feb 2-14)`);
  console.log(`Last month (Jan):    5 entries`);
  console.log(`Total: ${docs.length} entries\n`);

  // Verify
  const count = await MealLog.countDocuments({ patientId });
  console.log(`Total MealLog docs for patient: ${count}`);

  await mongoose.disconnect();
  console.log('Done!');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
