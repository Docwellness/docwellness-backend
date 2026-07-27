/**
 * FAKE/DEMO DATA - Test Frau A only (pawarbhushan08@gmail.com)
 * ============================================================
 * Seeds ~7 months (2026-01-01 -> today) of MealLog + Progress entries so the
 * Progress screen's three charts (Calorie Intake, Weight Trend, BMI) have
 * something to show for This week / This month / This year.
 *
 * WHY the activationDate change: the /tracking-data endpoint's Weight
 * Trend/BMI charts are NOT read from Progress history - they're computed
 * on the fly as a cumulative calorie-surplus-vs-TDEE curve starting at the
 * active DietPlan's `activationDate` (see getTrackingData in
 * controllers/patient/progressController.js). Test Frau A's plan activated
 * TODAY, so without backdating that field, every past week/month/year would
 * just show a flat line at her current weight - there'd be nothing to see.
 * Backdating activationDate does NOT affect which diet week she's shown
 * (that's driven by DietPlan.weekSchedule date ranges, checked separately -
 * this script leaves weekSchedule untouched), but it DOES temporarily affect
 * the dietician app's "estimate current weight from calorie data since
 * activation" helper (dietPlanController.js) if anyone tries to regenerate
 * her plan while this fake data is in place.
 *
 * This is exactly why --undo exists: run it to put everything back
 * (restores the real activationDate/totalCalories, deletes every MealLog in
 * the seeded range, deletes only the Progress entries this script tagged).
 *
 * Usage:
 *   node scripts/seed-fake-progress-data.js            # dry run
 *   node scripts/seed-fake-progress-data.js --execute  # seed the fake data
 *   node scripts/seed-fake-progress-data.js --undo     # remove it, restore activationDate
 */

require('dotenv').config();
require('dns').setServers(['8.8.8.8', '1.1.1.1']);
const mongoose = require('mongoose');

const EXECUTE = process.argv.includes('--execute');
const UNDO = process.argv.includes('--undo');
const EMAIL = 'pawarbhushan08@gmail.com';
const FAKE_TAG = '[FAKE-DEMO-DATA seed-fake-progress-data.js]';
// Local-time midnight, not UTC - getTrackingData's week/month/year boundary
// math (localDateStr, setHours(0,0,0,0), etc.) all runs in the server's
// local timezone. Anchoring this to UTC midnight instead caused a
// sub-day offset that made totalDays undercount by one, silently excluding
// "today" from the seeded range entirely.
const SEED_START = new Date(2026, 0, 1);
const PLANNED_CALORIES = 1800;

function localDateStr(date) {
  const d = new Date(date);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// getTrackingData's weightTrend/bmiTrend walk cumulativeWeight FORWARD from
// activationDate starting at *today's real currentWeight* - so unlike a
// real person (whose today's weight is the END of their journey), this
// synthetic curve treats day 1 (activationDate) as roughly today's weight
// and then drifts away from it for every day of surplus/deficit that
// follows. A sustained net deficit across the whole seeded range would
// leave "today" far below the real currentWeight shown elsewhere on the
// same screen (WeightInfoRow, the BMI badge) - a visible inconsistency.
// Oscillating around TDEE with ~zero net drift over the full range (an
// integer number of sine cycles) keeps every day's implied weight close to
// the real currentWeight while still giving the charts visible week-to-week
// movement instead of a flat line.
function dailyCalories(dayIndex, tdee, totalDays) {
  const period = totalDays / 3; // 3 full cycles over the seeded range -> ~zero net drift
  const amplitude = 400;
  const wave = amplitude * Math.sin((2 * Math.PI * dayIndex) / period);
  const noise = (Math.random() - 0.5) * 400;
  let calories = tdee + wave + noise;
  if (dayIndex % 21 === 10) calories += 500; // occasional higher day
  return Math.max(1000, Math.round(calories));
}

// Split a day's total across the app's meal slots.
const MEAL_SPLIT = [
  ['Morning Drink', 0.05],
  ['Breakfast', 0.2],
  ['Brunch', 0.05],
  ['Lunch', 0.3],
  ['Evening Snack', 0.1],
  ['Dinner', 0.25],
  ['Night Drink', 0.05],
];

function buildMeals(totalCalories) {
  return MEAL_SPLIT.map(([mealType, frac]) => ({
    mealType,
    servingTime: mealType,
    servings: 1,
    caloriesConsumed: Math.round(totalCalories * frac),
  }));
}

async function main() {
  console.log(
    UNDO
      ? '=== UNDO: removing fake demo data ==='
      : EXECUTE
        ? '=== EXECUTING: seeding fake demo data ==='
        : '=== DRY RUN (pass --execute to seed, --undo to remove) ==='
  );

  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected.');

  try {
    const { User, DietPlan, Progress, MealLog } = require('../models');

    const user = await User.findOne({ email: EMAIL }).select('healthProfile profile status').lean();
    if (!user) throw new Error(`Patient not found: ${EMAIL}`);
    console.log(`Patient: ${user._id}`);

    const activePlan = user.status?.activeDietPlanId
      ? await DietPlan.findById(user.status.activeDietPlanId)
      : await DietPlan.findOne({ patientId: user._id, status: 'Active' }).sort({ createdAt: -1 });
    if (!activePlan) throw new Error('No active DietPlan found for this patient.');

    console.log(`Active plan: ${activePlan._id}`);
    console.log(`  Current activationDate: ${activePlan.activationDate?.toISOString()}`);
    console.log(`  Current totalCalories: ${activePlan.totalCalories}`);

    if (UNDO) {
      const mealLogResult = EXECUTE
        ? await MealLog.deleteMany({
            patientId: user._id,
            date: { $gte: SEED_START },
            'meals.notes': FAKE_TAG,
          })
        : { deletedCount: await MealLog.countDocuments({ patientId: user._id, date: { $gte: SEED_START }, 'meals.notes': FAKE_TAG }) };
      console.log(`MealLog entries tagged as fake to delete: ${mealLogResult.deletedCount}`);

      const progressResult = EXECUTE
        ? await Progress.deleteMany({ patientId: user._id, notes: FAKE_TAG })
        : { deletedCount: await Progress.countDocuments({ patientId: user._id, notes: FAKE_TAG }) };
      console.log(`Progress entries tagged as fake to delete: ${progressResult.deletedCount}`);

      console.log('\nNOTE: this script does not know the *original* activationDate/totalCalories.');
      console.log('If you ran --execute earlier in this same terminal session, restore them manually with the values it printed at seed time.');

      if (EXECUTE) {
        console.log('\n=== UNDO DONE ===');
      } else {
        console.log('\nDry run - re-run with --execute to actually delete.');
      }
      return;
    }

    // ---- Seed path ----
    const originalActivationDate = activePlan.activationDate;
    const originalTotalCalories = activePlan.totalCalories;
    console.log('\n*** SAVE THESE TO RESTORE LATER (or just use --undo, but it cannot recover these exact values) ***');
    console.log(`  ORIGINAL activationDate: ${originalActivationDate?.toISOString()}`);
    console.log(`  ORIGINAL totalCalories: ${originalTotalCalories}`);
    console.log('***\n');

    const { calcAge, calcBmr, calcTdee } = require('../utils/dieticianPatientHelpers');
    const height = user.healthProfile?.height || 165;
    const currentWeight = user.healthProfile?.weight || 73;
    const age = calcAge(user.profile?.dateOfBirth) || 27;
    const gender = user.profile?.gender || 'Female';
    const activityLevel = user.healthProfile?.activityLevel || 'Moderate';
    const bmr = calcBmr({ weight: currentWeight, height, age, gender }) || 1500;
    const tdee = calcTdee(bmr, activityLevel) || bmr * 1.3;
    console.log(`Computed TDEE for seeding: ${Math.round(tdee)} kcal/day (bmr=${Math.round(bmr)}, age=${age}, gender=${gender}, activity=${activityLevel})`);

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    // Calendar-day count via incremental setDate(), not a millisecond
    // division - Jan 1 -> Jul 27 crosses the CEST/CET DST spring-forward
    // gap, so (today - SEED_START) / 86400000 undercounts by a fraction of
    // a day and silently drops the last (most important - "today") entry.
    let totalDays = 0;
    {
      const cursor = new Date(SEED_START);
      while (cursor <= today) {
        totalDays++;
        cursor.setDate(cursor.getDate() + 1);
      }
    }
    console.log(`Seeding MealLogs for ${totalDays} days: ${localDateStr(SEED_START)} -> ${localDateStr(today)}`);

    const existingMealLogs = await MealLog.countDocuments({ patientId: user._id, date: { $gte: SEED_START, $lte: today } });
    console.log(`Existing MealLog entries in this range (will be replaced): ${existingMealLogs}`);

    const existingFakeProgress = await Progress.countDocuments({ patientId: user._id, notes: FAKE_TAG });
    console.log(`Existing fake-tagged Progress entries (will be replaced): ${existingFakeProgress}`);

    if (!EXECUTE) {
      console.log('\nThis was a dry run - no changes made. Re-run with --execute to apply.');
      return;
    }

    // 1. Backdate activationDate + set a real calorie target
    activePlan.activationDate = SEED_START;
    activePlan.totalCalories = PLANNED_CALORIES;
    await activePlan.save();
    console.log('Backdated activationDate and set totalCalories.');

    // 2. Replace MealLogs in the seeded range
    await MealLog.deleteMany({ patientId: user._id, date: { $gte: SEED_START, $lte: today } });
    const mealLogDocs = [];
    const dayCursor = new Date(SEED_START);
    for (let i = 0; i < totalDays; i++) {
      const day = new Date(dayCursor);
      const totalCalories = dailyCalories(i, tdee, totalDays);
      const meals = buildMeals(totalCalories);
      meals[0].notes = FAKE_TAG; // tag first meal so --undo can find this doc
      mealLogDocs.push({
        patientId: user._id,
        date: day,
        meals,
        totalCalories,
      });
      dayCursor.setDate(dayCursor.getDate() + 1);
    }
    await MealLog.insertMany(mealLogDocs);
    console.log(`Inserted ${mealLogDocs.length} MealLog entries.`);

    // 3. Replace tagged Progress entries with a weekly declining-weight series
    //    (ends a few days before today so it doesn't collide with the real
    //    latest entry dated today).
    await Progress.deleteMany({ patientId: user._id, notes: FAKE_TAG });
    const progressEnd = new Date(today);
    progressEnd.setDate(today.getDate() - 3);
    const startWeight = currentWeight + 10.5; // gentle ~10.5kg loss narrative
    const startArm = 32,
      endArm = 29;
    const startWaist = 92,
      endWaist = 85;
    const startHip = 105,
      endHip = 99;

    const progressDocs = [];
    let d = new Date(SEED_START);
    let idx = 0;
    const totalSpanDays = Math.floor((progressEnd - SEED_START) / (1000 * 60 * 60 * 24));
    const totalWeeks = Math.max(1, Math.floor(totalSpanDays / 7));
    while (d <= progressEnd) {
      const frac = idx / totalWeeks;
      const weight = Math.round((startWeight - (startWeight - currentWeight) * Math.min(frac, 1)) * 10) / 10;
      const bmi = parseFloat((weight / ((height / 100) * (height / 100))).toFixed(2));
      progressDocs.push({
        patientId: user._id,
        date: new Date(d),
        weight,
        bmi,
        arm: Math.round((startArm - (startArm - endArm) * Math.min(frac, 1)) * 10) / 10,
        waist: Math.round((startWaist - (startWaist - endWaist) * Math.min(frac, 1)) * 10) / 10,
        hip: Math.round((startHip - (startHip - endHip) * Math.min(frac, 1)) * 10) / 10,
        adherence: 70 + Math.round(Math.random() * 25),
        notes: FAKE_TAG,
        source: 'patient',
      });
      d.setDate(d.getDate() + 7);
      idx++;
    }
    await Progress.insertMany(progressDocs);
    console.log(`Inserted ${progressDocs.length} Progress entries (weekly, ${startWeight}kg -> ~${currentWeight}kg).`);

    console.log('\n=== DONE ===');
    console.log('\nREMINDER: this is FAKE DEMO DATA on a real (test) patient record.');
    console.log(`Remove it with: node scripts/seed-fake-progress-data.js --undo --execute`);
    console.log(`Then manually restore DietPlan ${activePlan._id}:`);
    console.log(`  activationDate -> ${originalActivationDate?.toISOString()}`);
    console.log(`  totalCalories  -> ${originalTotalCalories}`);
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
