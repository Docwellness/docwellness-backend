/**
 * AI_EXECUTION_PLAN.md Phase 7, P7-05 (save-draft) - saveDraftWeek and
 * getDraftWeekOptions's finalizedPlan > draftPlan > generatedPlan fallback.
 */

const { connectTestDb, disconnectTestDb, clearTestDb } = require('./helpers/testDb');

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
  const patient = await createPatient({ profile: { fullName: 'Draft Patient' } });
  const dietPlan = await DietPlan.create({
    patientId: patient._id,
    dieticianId: dietician._id,
    status: 'Draft',
  });
  const recipe = await Recipe.create({
    dieticianId: dietician._id,
    name: 'Test Poha',
    servingTime: 'Breakfast',
  });
  registerTestToken('dietician-token', dietician._id);
  return { dietician, patient, dietPlan, recipe };
}

describe('PUT .../diet-plans/:dietPlanId/save-draft', () => {
  test('saves an incomplete/invalid selection without error (no blocking validation)', async () => {
    const { patient, dietPlan } = await setup();

    const res = await request(app)
      .put(`/api/dietician/patients/${patient._id}/diet-plans/${dietPlan._id}/save-draft`)
      .set('Authorization', 'Bearer dietician-token')
      .send({
        week: 1,
        selectedMeals: [
          // Valid entry.
          { dayGroup: 'Monday', servingTime: 'Breakfast', recipeId: '000000000000000000000001' },
          // Malformed entries cleanSelectedMeals should silently drop, not
          // reject the whole request over.
          { dayGroup: 'NotADay', servingTime: 'Breakfast', recipeId: '000000000000000000000002' },
          { dayGroup: 'Tuesday', servingTime: 'Breakfast' /* missing recipeId */ },
          null,
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toEqual(
      expect.objectContaining({ week: 1, savedAt: expect.any(String) })
    );

    const saved = await DietPlan.findById(dietPlan._id).lean();
    expect(saved.draftPlan.weeks).toHaveLength(1);
    expect(saved.draftPlan.weeks[0].dailyMeals).toHaveLength(1);
    expect(saved.status).toBe('Draft'); // unlike finalize, draft never promotes plan status
    expect(saved.weeksSummary).toEqual([]); // and never touches weeksSummary
  });

  test('rejects an out-of-range week number', async () => {
    const { patient, dietPlan } = await setup();

    const res = await request(app)
      .put(`/api/dietician/patients/${patient._id}/diet-plans/${dietPlan._id}/save-draft`)
      .set('Authorization', 'Bearer dietician-token')
      .send({ week: 9, selectedMeals: [] });

    expect(res.status).toBe(400);
  });
});

describe('GET .../weeks/:weekNumber/draft-options fallback chain', () => {
  test('a saved draft is retrievable with isDraftSaved: true, isFinalized: false', async () => {
    const { patient, dietPlan, recipe } = await setup();

    await request(app)
      .put(`/api/dietician/patients/${patient._id}/diet-plans/${dietPlan._id}/save-draft`)
      .set('Authorization', 'Bearer dietician-token')
      .send({
        week: 1,
        selectedMeals: [
          { dayGroup: 'Monday', servingTime: 'Breakfast', recipeId: recipe._id.toString() },
        ],
      });

    const res = await request(app)
      .get(`/api/dietician/patients/${patient._id}/diet-plans/${dietPlan._id}/weeks/1/draft-options`)
      .set('Authorization', 'Bearer dietician-token');

    expect(res.status).toBe(200);
    expect(res.body.data.isFinalized).toBe(false);
    expect(res.body.data.isDraftSaved).toBe(true);
  });

  test('a finalized week wins over an existing draft for the same week', async () => {
    const { patient, dietPlan, recipe } = await setup();

    // Save a draft, then finalize the same week with different content.
    await request(app)
      .put(`/api/dietician/patients/${patient._id}/diet-plans/${dietPlan._id}/save-draft`)
      .set('Authorization', 'Bearer dietician-token')
      .send({
        week: 1,
        selectedMeals: [
          { dayGroup: 'Monday', servingTime: 'Breakfast', recipeId: recipe._id.toString() },
        ],
      });

    await DietPlan.findByIdAndUpdate(dietPlan._id, {
      finalizedPlan: {
        weeks: [
          {
            week: 1,
            dailyMeals: [
              { dayGroup: 'Monday', servingTime: 'Breakfast', recipeId: recipe._id.toString(), servings: 2 },
            ],
          },
        ],
      },
    });

    const res = await request(app)
      .get(`/api/dietician/patients/${patient._id}/diet-plans/${dietPlan._id}/weeks/1/draft-options`)
      .set('Authorization', 'Bearer dietician-token');

    expect(res.status).toBe(200);
    expect(res.body.data.isFinalized).toBe(true);
    expect(res.body.data.isDraftSaved).toBe(false);
  });
});
