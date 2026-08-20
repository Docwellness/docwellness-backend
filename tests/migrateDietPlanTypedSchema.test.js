/**
 * scripts/migrate-diet-plan-typed-schema.js - backfills the typed days[]
 * schema from legacy finalizedPlan/draftPlan blobs on real (mongodb-
 * memory-server) DietPlan documents, including the edge cases the script's
 * header calls out: draft-only weeks, and a recipeId pointing at a deleted
 * Recipe.
 */

const { connectTestDb, disconnectTestDb, clearTestDb } = require('./helpers/testDb');

let DietPlan;
let Recipe;
let createPatient;
let createDietician;
let runBackfill;
let runVerify;
let getFinalizedWeeks;
let getDraftWeeks;
let buildLegacyWeeksView;
let daysFromLegacyWeekPayload;

beforeAll(async () => {
  await connectTestDb();
  ({ DietPlan, Recipe } = require('../models'));
  ({ createPatient, createDietician } = require('./helpers/factories'));
  ({ runBackfill, runVerify } = require('../scripts/migrate-diet-plan-typed-schema'));
  ({ getFinalizedWeeks, getDraftWeeks, buildLegacyWeeksView, daysFromLegacyWeekPayload } = require('../utils/dietPlanLegacyView'));
});

afterEach(async () => {
  await clearTestDb();
});

afterAll(async () => {
  await disconnectTestDb();
});

async function makePlanWithLegacyData({ dieticianId, patientId, recipeId, includeDraftOnlyWeek = false }) {
  const finalizedWeek1 = {
    week: 1,
    dailyMeals: [
      { dayGroup: 'Monday', servingTime: 'Breakfast', recipeId: recipeId.toString(), servings: 2 },
      { dayGroup: 'Wednesday', servingTime: 'Dinner', recipeId: recipeId.toString(), servings: 1 },
    ],
  };
  const draftPlan = { weeks: [{ week: 1, dailyMeals: finalizedWeek1.dailyMeals }] };
  if (includeDraftOnlyWeek) {
    draftPlan.weeks.push({
      week: 2,
      dailyMeals: [{ dayGroup: 'Tuesday', servingTime: 'Lunch', recipeId: recipeId.toString(), servings: 1 }],
    });
  }

  return DietPlan.create({
    patientId,
    dieticianId,
    status: 'Finalized',
    finalizedPlan: { weeks: [finalizedWeek1] },
    draftPlan,
  });
}

describe('migrate-diet-plan-typed-schema.js dry run', () => {
  test('reports the plan without writing anything', async () => {
    const dietician = await createDietician();
    const patient = await createPatient();
    const recipe = await Recipe.create({ dieticianId: dietician._id, name: 'Poha', servingTime: 'Breakfast' });
    await makePlanWithLegacyData({ dieticianId: dietician._id, patientId: patient._id, recipeId: recipe._id });

    const result = await runBackfill({
      DietPlan,
      Recipe,
      daysFromLegacyWeekPayload,
      getFinalizedWeeks,
      getDraftWeeks,
      execute: false,
    });

    expect(result.migratedCount).toBe(1);
    expect(result.dayEntriesBackfilled).toBe(2); // Monday + Wednesday entries for week 1

    const stored = await DietPlan.findOne().lean();
    expect(stored.days).toEqual([]);
    expect(stored.daysSchemaMigratedAt).toBeNull();
  });
});

describe('migrate-diet-plan-typed-schema.js --execute', () => {
  test('backfills days[], marks the plan migrated, and is idempotent on re-run', async () => {
    const dietician = await createDietician();
    const patient = await createPatient();
    const recipe = await Recipe.create({ dieticianId: dietician._id, name: 'Poha', servingTime: 'Breakfast' });
    await makePlanWithLegacyData({ dieticianId: dietician._id, patientId: patient._id, recipeId: recipe._id });

    await runBackfill({ DietPlan, Recipe, daysFromLegacyWeekPayload, getFinalizedWeeks, getDraftWeeks, execute: true });

    const migrated = await DietPlan.findOne();
    expect(migrated.daysSchemaMigratedAt).not.toBeNull();
    expect(migrated.days).toHaveLength(2); // Monday + Wednesday entries for week 1
    expect(migrated.days.map((d) => d.dayGroup).sort()).toEqual(['Monday', 'Wednesday']);

    // Re-running must be a no-op (idempotent) - the plan is now excluded by
    // the daysSchemaMigratedAt:null query, so a second pass finds nothing.
    const secondPass = await runBackfill({
      DietPlan,
      Recipe,
      daysFromLegacyWeekPayload,
      getFinalizedWeeks,
      getDraftWeeks,
      execute: true,
    });
    expect(secondPass.migratedCount).toBe(0);
  });

  test('archives a draft-only week (no matching finalizedPlan entry) instead of writing it into days[]', async () => {
    const dietician = await createDietician();
    const patient = await createPatient();
    const recipe = await Recipe.create({ dieticianId: dietician._id, name: 'Poha', servingTime: 'Breakfast' });
    await makePlanWithLegacyData({
      dieticianId: dietician._id,
      patientId: patient._id,
      recipeId: recipe._id,
      includeDraftOnlyWeek: true,
    });

    const result = await runBackfill({
      DietPlan,
      Recipe,
      daysFromLegacyWeekPayload,
      getFinalizedWeeks,
      getDraftWeeks,
      execute: true,
    });
    expect(result.draftOnlyWeeksArchived).toBe(1);

    const migrated = await DietPlan.findOne();
    expect(migrated.days.every((d) => d.week === 1)).toBe(true); // week 2 (draft-only) never entered days[]
    expect(migrated.legacyDraftPlanArchive.weeks).toEqual([
      expect.objectContaining({ week: 2 }),
    ]);
  });

  test('flags a recipeId that no longer resolves to a real Recipe, without blocking migration', async () => {
    const dietician = await createDietician();
    const patient = await createPatient();
    const deletedRecipe = await Recipe.create({ dieticianId: dietician._id, name: 'Deleted', servingTime: 'Breakfast' });
    const deletedRecipeId = deletedRecipe._id;
    await Recipe.deleteOne({ _id: deletedRecipeId });
    await makePlanWithLegacyData({ dieticianId: dietician._id, patientId: patient._id, recipeId: deletedRecipeId });

    const result = await runBackfill({
      DietPlan,
      Recipe,
      daysFromLegacyWeekPayload,
      getFinalizedWeeks,
      getDraftWeeks,
      execute: true,
    });

    expect(result.danglingRecipeWarnings).toHaveLength(1);
    expect(result.danglingRecipeWarnings[0].dangling).toContain(deletedRecipeId.toString());

    // Still migrates - a dangling reference is a warning for manual review,
    // not a reason to leave the whole plan unmigrated.
    const migrated = await DietPlan.findOne();
    expect(migrated.daysSchemaMigratedAt).not.toBeNull();
  });

  test('skips a week already present in days[] from finalizeWeekPlan\'s dual-write', async () => {
    const dietician = await createDietician();
    const patient = await createPatient();
    const recipe = await Recipe.create({ dieticianId: dietician._id, name: 'Poha', servingTime: 'Breakfast' });
    const plan = await makePlanWithLegacyData({ dieticianId: dietician._id, patientId: patient._id, recipeId: recipe._id });

    // Simulate finalizeWeekPlan's dual-write having already populated week 1
    // with different (hand-edited-since) data, before the backfill script runs.
    plan.days = [
      {
        week: 1,
        dayGroup: 'Monday',
        meals: [{ servingTime: 'Breakfast', items: [{ recipeId: recipe._id, servingMultiplier: 99 }], supplements: [] }],
      },
    ];
    await plan.save();

    await runBackfill({ DietPlan, Recipe, daysFromLegacyWeekPayload, getFinalizedWeeks, getDraftWeeks, execute: true });

    const migrated = await DietPlan.findOne();
    // Untouched by the backfill - the dual-written value (99) survives,
    // rather than being overwritten by the legacy blob's value (2).
    expect(migrated.days).toHaveLength(1);
    expect(migrated.days[0].meals[0].items[0].servingMultiplier).toBe(99);
  });
});

describe('migrate-diet-plan-typed-schema.js --verify', () => {
  test('reports zero divergence for a correctly migrated plan', async () => {
    const dietician = await createDietician();
    const patient = await createPatient();
    const recipe = await Recipe.create({ dieticianId: dietician._id, name: 'Poha', servingTime: 'Breakfast' });
    await makePlanWithLegacyData({ dieticianId: dietician._id, patientId: patient._id, recipeId: recipe._id });

    await runBackfill({ DietPlan, Recipe, daysFromLegacyWeekPayload, getFinalizedWeeks, getDraftWeeks, execute: true });
    const result = await runVerify({ DietPlan, buildLegacyWeeksView, getFinalizedWeeks });

    expect(result.total).toBe(1);
    expect(result.clean).toBe(1);
    expect(result.failures).toEqual([]);
  });

  test('flags divergence when days[] disagrees with the original finalizedPlan blob', async () => {
    const dietician = await createDietician();
    const patient = await createPatient();
    const recipe = await Recipe.create({ dieticianId: dietician._id, name: 'Poha', servingTime: 'Breakfast' });
    const plan = await makePlanWithLegacyData({ dieticianId: dietician._id, patientId: patient._id, recipeId: recipe._id });

    await runBackfill({ DietPlan, Recipe, daysFromLegacyWeekPayload, getFinalizedWeeks, getDraftWeeks, execute: true });

    // Corrupt the migrated data directly, simulating a migration bug.
    const migrated = await DietPlan.findOne();
    migrated.days[0].meals[0].items[0].servingMultiplier = 12345;
    await migrated.save();

    const result = await runVerify({ DietPlan, buildLegacyWeeksView, getFinalizedWeeks });
    expect(result.clean).toBe(0);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].diffs[0].week).toBe(1);
  });
});
