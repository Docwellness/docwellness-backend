/**
 * Read-only probe: how much reviewed, user-linked data exists for building the
 * Laya evaluation datasets (docwellness-laya-production-integration-plan.md,
 * section 10)? Prints COUNTS ONLY: no names, no health details, no free text, no
 * ids. Nothing is written anywhere.
 *
 * Question it answers: which of the five datasets can reach ~100 examples?
 *   recipe classification / meal type -> reviewed recipes and their labels
 *   user-preference matching          -> finalized plans linked to a consultation
 *   compatibility                     -> consultations that declare allergies / foods to avoid
 *   review gating                     -> recipe swaps by a dietician (and how many give a reason)
 *
 * Usage (backend Terminal; needs the production DB):
 *   node scripts/laya-data-probe.js
 */
require('dotenv').config({ quiet: true });
const mongoose = require('mongoose');
const connectDB = require('../config/database');
const Recipe = require('../models/Recipe');
const DietPlan = require('../models/DietPlan');
const FirstConsultation = require('../models/FirstConsultation');
const User = require('../models/User');
const GenerationLog = require('../models/GenerationLog');

const results = [];

/** Runs one count; a failure is reported on its line and never stops the probe. */
async function probe(section, label, fn) {
  try {
    results.push({ section, label, value: await fn() });
  } catch (err) {
    results.push({ section, label, value: `error: ${err.message}` });
  }
}

const aggCount = async (model, pipeline) => {
  const rows = await model.aggregate([...pipeline, { $count: 'n' }]);
  return rows.length ? rows[0].n : 0;
};

const nonEmptyArray = (path) => ({ [path]: { $exists: true, $type: 'array', $ne: [] } });

async function main() {
  await connectDB();

  // ---- Recipes ----------------------------------------------------------
  await probe('Recipes', 'total', () => Recipe.countDocuments({}));
  await probe('Recipes', 'with at least one ingredient', () => Recipe.countDocuments(nonEmptyArray('ingredients')));
  await probe('Recipes', 'vegetarian flag set', () => Recipe.countDocuments({ 'dietaryHabits.vegetarian': true }));
  await probe('Recipes', 'vegan flag set', () => Recipe.countDocuments({ 'dietaryHabits.vegan': true }));
  await probe('Recipes', 'jain flag set', () => Recipe.countDocuments({ 'dietaryHabits.jain': true }));
  await probe('Recipes', 'non-vegetarian flag set', () => Recipe.countDocuments({ 'dietaryHabits.nonVegetarian': true }));
  await probe('Recipes', 'eggitarian flag set', () => Recipe.countDocuments({ 'dietaryHabits.eggitarian': true }));
  await probe('Recipes', 'no dietary flag set at all', () =>
    Recipe.countDocuments({
      'dietaryHabits.vegan': { $ne: true },
      'dietaryHabits.jain': { $ne: true },
      'dietaryHabits.vegetarian': { $ne: true },
      'dietaryHabits.nonVegetarian': { $ne: true },
      'dietaryHabits.eggitarian': { $ne: true },
    }));
  await probe('Recipes', 'any freeFrom flag set', () =>
    Recipe.countDocuments({ $or: ['sugar', 'salt', 'processedFood', 'oil'].map((k) => ({ [`freeFrom.${k}`]: true })) }));
  await probe('Recipes', 'with allergens listed', () => Recipe.countDocuments(nonEmptyArray('allergens')));
  await probe('Recipes', 'with a category', () => Recipe.countDocuments({ category: { $exists: true, $nin: [null, ''] } }));
  await probe('Recipes', 'edited versions (version > 1 or has a parent)', () =>
    Recipe.countDocuments({ $or: [{ version: { $gt: 1 } }, { parentRecipeId: { $ne: null } }] }));

  // ---- Users and consultations -----------------------------------------
  await probe('Users', 'patients', () => User.countDocuments({ role: 'patient' }));
  await probe('Users', 'patients linked to a first consultation', () =>
    User.countDocuments({ role: 'patient', 'status.firstConsultationId': { $ne: null, $exists: true } }));
  await probe('Consultations', 'total', () => FirstConsultation.countDocuments({}));
  await probe('Consultations', 'declares allergies / intolerances', () =>
    FirstConsultation.countDocuments(nonEmptyArray('dietaryHabitsAllergies.allergiesIntolerances.options')));
  await probe('Consultations', 'lists foods to avoid', () =>
    FirstConsultation.countDocuments({ 'dietaryHabitsAllergies.foodsToAvoid.text': { $nin: [null, ''] } }));
  await probe('Consultations', 'states a current eating style', () =>
    FirstConsultation.countDocuments(nonEmptyArray('dietaryHabitsAllergies.currentEatingStyle.options')));
  await probe('Consultations', 'lists cravings', () =>
    FirstConsultation.countDocuments(nonEmptyArray('dietaryHabitsAllergies.cravings.options')));

  // ---- Diet plans -------------------------------------------------------
  await probe('Plans', 'total', () => DietPlan.countDocuments({}));
  for (const status of ['Draft', 'Active', 'Completed', 'Finalized']) {
    await probe('Plans', `status ${status}`, () => DietPlan.countDocuments({ status }));
  }
  await probe('Plans', 'with a linked first consultation', () =>
    DietPlan.countDocuments({ firstConsultation: { $ne: null, $exists: true } }));
  await probe('Plans', 'with meals in days[] (the source of truth)', () => DietPlan.countDocuments(nonEmptyArray('days')));
  await probe('Plans', 'with days[] AND a linked consultation', () =>
    DietPlan.countDocuments({ ...nonEmptyArray('days'), firstConsultation: { $ne: null, $exists: true } }));
  await probe('Plans', 'distinct patients with a plan that has days[]', async () => {
    const rows = await DietPlan.aggregate([{ $match: nonEmptyArray('days') }, { $group: { _id: '$patientId' } }, { $count: 'n' }]);
    return rows.length ? rows[0].n : 0;
  });
  await probe('Plans', 'plan items (recipe placements) in days[]', () =>
    aggCount(DietPlan, [{ $unwind: '$days' }, { $unwind: '$days.meals' }, { $unwind: '$days.meals.items' }]));
  await probe('Plans', 'placements in plans that have a linked consultation', () =>
    aggCount(DietPlan, [
      { $match: { firstConsultation: { $ne: null, $exists: true } } },
      { $unwind: '$days' }, { $unwind: '$days.meals' }, { $unwind: '$days.meals.items' },
    ]));
  await probe('Plans', 'distinct recipes placed in plans', async () => {
    const rows = await DietPlan.aggregate([
      { $unwind: '$days' }, { $unwind: '$days.meals' }, { $unwind: '$days.meals.items' },
      { $group: { _id: '$days.meals.items.recipeId' } }, { $count: 'n' },
    ]);
    return rows.length ? rows[0].n : 0;
  });

  // ---- Swaps (a dietician replacing a recipe) ---------------------------
  const swapStages = [
    { $unwind: '$days' }, { $unwind: '$days.meals' }, { $unwind: '$days.meals.items' },
    { $unwind: '$days.meals.items.swapHistory' },
  ];
  await probe('Swaps', 'swap events', () => aggCount(DietPlan, swapStages));
  await probe('Swaps', 'swap events that give a reason', () =>
    aggCount(DietPlan, [...swapStages, { $match: { 'days.meals.items.swapHistory.reason': { $nin: [null, ''] } } }]));
  await probe('Swaps', 'swap events in plans with a linked consultation', () =>
    aggCount(DietPlan, [{ $match: { firstConsultation: { $ne: null, $exists: true } } }, ...swapStages]));
  await probe('Swaps', 'distinct plans with at least one swap', async () => {
    const rows = await DietPlan.aggregate([...swapStages, { $group: { _id: '$_id' } }, { $count: 'n' }]);
    return rows.length ? rows[0].n : 0;
  });

  // ---- Generation log (what the plan generator recorded) ---------------
  await probe('GenerationLog', 'diet-plan generations', () => GenerationLog.countDocuments({ kind: 'dietPlan' }));
  await probe('GenerationLog', 'diet-plan generations that succeeded', () => GenerationLog.countDocuments({ kind: 'dietPlan', succeeded: true }));
  await probe('GenerationLog', 'diet-plan generations with validator warnings', () =>
    GenerationLog.countDocuments({ kind: 'dietPlan', ...nonEmptyArray('validatorWarnings') }));
  await probe('GenerationLog', 'recipe generations', () => GenerationLog.countDocuments({ kind: 'recipe' }));

  // ---- Print ------------------------------------------------------------
  console.log('Laya data probe (counts only; no personal or health data is printed)\n');
  let section = null;
  for (const r of results) {
    if (r.section !== section) {
      section = r.section;
      console.log(`\n${section}`);
    }
    console.log(`  ${String(r.value).padStart(8)}  ${r.label}`);
  }
  console.log('\nRead it as: a dataset needs ~100 examples of the thing being measured. Recipe labels and plan placements');
  console.log('measure classification and preference ranking; swap events (ideally with a reason) are the only real');
  console.log('"the dietician disagreed" cases, so they bound what review gating can learn.');
}

main()
  .catch((err) => {
    console.error(`Probe failed: ${err.message}`);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
