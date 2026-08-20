/**
 * Regression coverage for finalizeWeekPlan's dual-write (Phase 1d): a real
 * PUT .../finalize-week request must leave BOTH the legacy finalizedPlan
 * blob AND the typed days[] schema populated, and derivable from each other
 * via utils/dietPlanLegacyView.js - the concrete "flow/results aren't
 * broken" check for the schema evolution itself (independent of the
 * recipeSelectionEngine's own parity tests).
 */

const { connectTestDb, disconnectTestDb, clearTestDb } = require('./helpers/testDb');
const { buildLegacyWeeksView } = require('../utils/dietPlanLegacyView');

jest.mock('../utils/supabaseAuth');
const { registerTestToken, clearTestTokens } = require('../utils/supabaseAuth');

let request;
let app;
let createPatient;
let createDietician;
let Recipe;
let DietPlan;

beforeAll(async () => {
  await connectTestDb();
  request = require('supertest');
  app = require('../config/createApp')();
  ({ createPatient, createDietician } = require('./helpers/factories'));
  ({ Recipe, DietPlan } = require('../models'));
});

afterEach(async () => {
  clearTestTokens();
  await clearTestDb();
});

afterAll(async () => {
  await disconnectTestDb();
});

async function setup() {
  const dietician = await createDietician();
  const patient = await createPatient();
  // Deliberately no components/servingSize (matches tests/dietPlanDraft.test.js's
  // fixture convention) - utils/weekNutritionSummary.js's computeMealRatio
  // scales nutrition by (meal.servings / recipe's base component quantity);
  // with no components at all, componentsForRecipe falls back to a base
  // quantity of 1, so this test's servings:1/2 payloads give exact 1x/2x
  // ratios instead of a near-zero one against an unrelated base quantity.
  const recipe = await Recipe.create({
    dieticianId: dietician._id,
    name: 'Poha',
    servingTime: 'Breakfast',
    nutrition: { calories: 300, protein: 8, carbs: 45, fats: 10, fiber: 3 },
  });
  const dietPlan = await DietPlan.create({
    patientId: patient._id,
    dieticianId: dietician._id,
    status: 'Draft',
    calorieStrategy: { calorieBudget: 300 },
  });
  registerTestToken('dietician-token', dietician._id);
  return { dietician, patient, dietPlan, recipe };
}

describe('finalizeWeekPlan dual-write into days[]', () => {
  test('a finalize-week request populates both finalizedPlan and days[] consistently', async () => {
    const { patient, dietPlan, recipe } = await setup();

    const res = await request(app)
      .put(`/api/dietician/patients/${patient._id}/diet-plans/${dietPlan._id}/finalize-week`)
      .set('Authorization', 'Bearer dietician-token')
      .send({
        week: 1,
        selectedMeals: [
          { dayGroup: 'Monday', servingTime: 'Breakfast', recipeId: recipe._id.toString(), servings: 1 },
          { dayGroup: 'Wednesday', servingTime: 'Breakfast', recipeId: recipe._id.toString(), servings: 2 },
        ],
      });

    expect(res.status).toBe(200);

    const saved = await DietPlan.findById(dietPlan._id);

    // Legacy blob: written exactly as before (unchanged behavior).
    expect(saved.finalizedPlan.weeks).toHaveLength(1);
    expect(saved.finalizedPlan.weeks[0].dailyMeals).toHaveLength(2);

    // Typed schema: dual-written by the same request.
    expect(saved.days).toHaveLength(2); // Monday entry + Wednesday entry, both week 1
    expect(saved.days.every((d) => d.week === 1)).toBe(true);
    const wednesday = saved.days.find((d) => d.dayGroup === 'Wednesday');
    expect(wednesday.meals[0].items[0].servingMultiplier).toBe(2);

    // The two representations agree when round-tripped through the shim.
    const derived = buildLegacyWeeksView(saved);
    const derivedWeek1 = derived.weeks.find((w) => w.week === 1).dailyMeals;
    const originalWeek1 = saved.finalizedPlan.weeks[0].dailyMeals;
    const canonicalize = (m) => JSON.stringify({ dayGroup: m.dayGroup, servingTime: m.servingTime, recipeId: m.recipeId.toString(), servings: m.servings });
    expect(derivedWeek1.map(canonicalize).sort()).toEqual(originalWeek1.map(canonicalize).sort());
  });

  test('re-finalizing the same week fully replaces days[] for that week, not appends', async () => {
    const { patient, dietPlan, recipe } = await setup();
    const url = `/api/dietician/patients/${patient._id}/diet-plans/${dietPlan._id}/finalize-week`;

    // computeWeekSummary (utils/weekNutritionSummary.js) weights a
    // submission's estimated calories against the FULL week's day-group
    // representation (7), not just the day-groups present in this one
    // request - so filling all 4 groups at servings:1 each (300 cal * 7 / 7
    // = 300, matching this plan's 300 cal budget exactly) avoids
    // computeFinalizeBlockingIssues' severe-deviation block, whereas a
    // single filled day-group alone would look artificially low relative to
    // a full week's budget and get rejected. Not this test's concern -
    // filling every group here just sidesteps that existing check to
    // isolate what IS this test's concern: replace-not-append semantics.
    const allFourGroups = (recipeId) =>
      ['Monday', 'Tuesday', 'Wednesday', 'Thursday'].map((dayGroup) => ({
        dayGroup,
        servingTime: 'Breakfast',
        recipeId,
        servings: 1,
      }));

    const firstRes = await request(app)
      .put(url)
      .set('Authorization', 'Bearer dietician-token')
      .send({ week: 1, selectedMeals: allFourGroups(recipe._id.toString()) });
    expect(firstRes.status).toBe(200);

    const afterFirst = await DietPlan.findById(dietPlan._id).lean();
    expect(afterFirst.days).toHaveLength(4);

    const secondRes = await request(app)
      .put(url)
      .set('Authorization', 'Bearer dietician-token')
      .send({ week: 1, selectedMeals: allFourGroups(recipe._id.toString()) });
    expect(secondRes.status).toBe(200);

    const afterSecond = await DietPlan.findById(dietPlan._id).lean();
    // Still 4, not 8 - the second finalize replaced week 1's days[] entries
    // rather than appending duplicates alongside them.
    expect(afterSecond.days).toHaveLength(4);
  });
});
