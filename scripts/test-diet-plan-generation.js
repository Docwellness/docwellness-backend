/**
 * One-off verification script (NOT a permanent test suite entry) that
 * exercises the real AI diet-plan generation pipeline end-to-end against a
 * fully synthetic, throwaway patient/consultation/diet-plan - never touches
 * any real patient data, and deletes everything it creates in a `finally`
 * block regardless of outcome.
 *
 * Verifies:
 *  1. Generation completes without error and produces a parseable plan.
 *  2. Every recipeId the AI chose exists in the recipe pool it was given
 *     (closed-world check, already enforced by utils/dietPlanValidator.js -
 *     this script also independently re-checks against the live DB).
 *  3. None of the chosen recipes' ingredients conflict with the synthetic
 *     patient's stated allergies/foods-to-avoid (independently re-verified
 *     here, not just trusting the pre-filter that already excluded them
 *     from the pool - a true end-to-end check).
 *  4. Every servingTime slot required by the schema is present each week.
 *
 * Usage: node scripts/test-diet-plan-generation.js
 */

require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

async function main() {
  console.log('=== Diet plan generation end-to-end test (synthetic data only) ===\n');
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected to MongoDB.\n');

  const { User, FirstConsultation, DietPlan, Recipe } = require('../models');
  const { findAllergenConflicts, getConsultationAnswer } = require('../utils/dietaryConstraintValidator');
  const { SAFETY_FIELD_IDS } = require('../utils/consultationFormSeed');

  let testPatient, testConsultation, testDietPlan;

  try {
    const dietician = await User.findOne({ email: 'localdietician@dev.local', role: 'dietician' });
    if (!dietician) throw new Error('Dietician account not found - cannot run test.');
    console.log('Using dietician:', dietician.email, dietician._id.toString());

    // --- Create a fully synthetic, clearly-marked test patient ---
    const hashedPassword = await bcrypt.hash('test-only-not-a-real-account', 10);
    const uniqueSuffix = Date.now();
    testPatient = await User.create({
      email: `zz-diet-plan-verification-${uniqueSuffix}@test.invalid`,
      password: hashedPassword,
      role: 'patient',
      profile: {
        fullName: 'ZZ Test Patient (diet plan verification - safe to delete)',
        gender: 'Female',
        dateOfBirth: new Date('1995-06-15'),
      },
      healthProfile: {
        weight: 65,
        height: 165,
        bmi: 23.9,
        primaryGoal: 'Weight Loss',
      },
    });
    console.log('Created synthetic test patient:', testPatient._id.toString());

    // Deliberately choose allergy categories that were previously broken
    // (Gluten, Dairy/Lactose, Seafood all had 0% real-ingredient match
    // before today's fix) plus a free-text "foods to avoid" entry, so this
    // run also serves as a regression check for that fix.
    testConsultation = await FirstConsultation.create({
      patient: testPatient._id,
      dietician: dietician._id,
      customAnswers: [
        { fieldId: SAFETY_FIELD_IDS.EATING_STYLE, label: 'Current eating style', type: 'singleChoice', value: 'Vegetarian' },
        { fieldId: SAFETY_FIELD_IDS.ALLERGIES, label: 'Allergies or intolerances', type: 'multiChoice', value: ['Gluten', 'Dairy / Lactose', 'Seafood'] },
        { fieldId: SAFETY_FIELD_IDS.FOODS_TO_AVOID, label: 'Foods to avoid', type: 'textarea', value: 'mushrooms, brinjal' },
      ],
    });
    console.log('Created synthetic consultation:', testConsultation._id.toString());
    console.log('  Stated allergies: Gluten, Dairy / Lactose, Seafood');
    console.log('  Foods to avoid (free text): mushrooms, brinjal\n');

    testDietPlan = await DietPlan.create({
      patientId: testPatient._id,
      dieticianId: dietician._id,
      firstConsultation: testConsultation._id,
      calorieStrategy: { name: 'Standard Deficit', calorieBudget: 1500, calorieDeficit: 500, weeklyWeightLossKg: 0.5, durationWeeks: 4 },
      macroStrategy: { name: 'Balanced', fatPercent: 25, carbsPercent: 45, proteinPercent: 30, fiberGrams: 25 },
      status: 'Draft',
    });
    await testDietPlan.populate([
      { path: 'patientId', select: 'profile healthProfile' },
      { path: 'firstConsultation' },
    ]);
    console.log('Created synthetic diet plan:', testDietPlan._id.toString(), '\n');

    // --- Run the real generation pipeline (week 1 only, to keep it fast/cheap) ---
    const { runDietPlanGeneration } = require('../controllers/dietician/dietPlanController');
    console.log('Running runDietPlanGeneration (week 1)...\n');
    const result = await runDietPlanGeneration({
      dietPlan: testDietPlan,
      dieticianId: dietician._id,
      weekNumbers: [1],
    });

    if (!result.ok) {
      console.error('❌ Generation FAILED:', result.status, result.message);
      return;
    }
    console.log('✅ Generation completed without error.\n');

    // Re-fetch the saved plan (runDietPlanGeneration saved it to testDietPlan/DB)
    const saved = await DietPlan.findById(testDietPlan._id).lean();
    console.log('Validation warnings from the pipeline itself:');
    if (saved.validationWarnings.length === 0) console.log('  (none)');
    saved.validationWarnings.forEach((w) => console.log('  -', w));
    console.log();

    const parsedPlan = JSON.parse(saved.generatedPlan);
    const week1 = parsedPlan.weeks.find((w) => w.week === 1);
    if (!week1) {
      console.error('❌ No week 1 found in generated plan.');
      return;
    }

    console.log(`Week 1 has ${week1.dailyMeals.length} meal slot(s):\n`);

    const REQUIRED_SERVING_TIMES = [
      'Morning Drink', 'Breakfast', 'Brunch', 'Lunch', 'Evening Snack', 'Dinner', 'Night Drink',
    ];
    const presentServingTimes = new Set(week1.dailyMeals.map((m) => m.servingTime));
    const missingServingTimes = REQUIRED_SERVING_TIMES.filter((st) => !presentServingTimes.has(st));
    console.log(missingServingTimes.length === 0
      ? '✅ All 7 required servingTime slots are present.'
      : `❌ MISSING servingTime slots: ${missingServingTimes.join(', ')}`);

    // Independent re-verification: for every chosen recipe, (a) confirm it
    // really exists in the DB (closed-world), (b) re-run the allergy check
    // against its real ingredients as a true end-to-end safety check.
    const allergyOptions = getConsultationAnswer(testConsultation.customAnswers, SAFETY_FIELD_IDS.ALLERGIES);
    const foodsToAvoidText = getConsultationAnswer(testConsultation.customAnswers, SAFETY_FIELD_IDS.FOODS_TO_AVOID);

    let allSafe = true;
    let allExist = true;
    console.log('\nPer-meal verification:');
    for (const meal of week1.dailyMeals) {
      const recipe = await Recipe.findById(meal.recipeId).lean();
      if (!recipe) {
        allExist = false;
        console.log(`  ❌ ${meal.servingTime}: recipeId ${meal.recipeId} does NOT exist in the DB (hallucinated/invalid reference)`);
        continue;
      }
      const conflicts = findAllergenConflicts({
        ingredients: recipe.ingredients,
        allergyOptions,
        foodsToAvoidText,
      });
      const servingTimeMatches = recipe.servingTime === meal.servingTime;
      if (conflicts.length > 0) allSafe = false;
      console.log(
        `  ${conflicts.length > 0 ? '❌' : '✅'} ${meal.servingTime}: "${recipe.name}"` +
        (servingTimeMatches ? '' : ` [servingTime MISMATCH: recipe is ${recipe.servingTime}]`) +
        (conflicts.length > 0 ? ` - ALLERGEN CONFLICT: ${conflicts.map(c => c.ingredient).join(', ')}` : '')
      );
    }

    console.log('\n=== SUMMARY ===');
    console.log('Recipe pool closed-world integrity:', allExist ? '✅ PASS - every chosen recipe exists' : '❌ FAIL');
    console.log('Allergy/avoidable safety (independent re-check):', allSafe ? '✅ PASS - no conflicts in final plan' : '❌ FAIL');
    console.log('All required servingTime slots present:', missingServingTimes.length === 0 ? '✅ PASS' : '❌ FAIL');
    console.log('\nNote on "options": the current schema (utils/dietPlanJsonSchema.js) assigns');
    console.log('exactly ONE recipeId per servingTime slot per week - there is no multiple-');
    console.log('alternative-recipes-per-slot feature in the generation pipeline today.');
  } finally {
    // Always clean up, even on failure - never leave synthetic data behind.
    console.log('\nCleaning up synthetic test data...');
    if (testDietPlan) await DietPlan.deleteOne({ _id: testDietPlan._id });
    if (testConsultation) await FirstConsultation.deleteOne({ _id: testConsultation._id });
    if (testPatient) await User.deleteOne({ _id: testPatient._id });
    console.log('Cleanup complete - no synthetic data left in the database.');
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error('Test script crashed:', err);
  process.exit(1);
});
