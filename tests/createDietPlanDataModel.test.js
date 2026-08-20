/**
 * controllers/dietician/dietPlanController.js::createAndGenerateDietPlan -
 * the v4.0 dataModel wiring. Set DIET_PLAN_DATA_MODEL BEFORE any require
 * (including testDb.js) so config/environment.js captures 'plan-item' the
 * first time it's loaded in this test file's own module registry (Jest
 * gives each test FILE a fresh registry, so this doesn't leak into other
 * files, which all default to 'days-array' as before).
 */
process.env.DIET_PLAN_DATA_MODEL = 'plan-item';

const { connectTestDb, disconnectTestDb, clearTestDb } = require('./helpers/testDb');

jest.mock('../utils/supabaseAuth');
const { registerTestToken, clearTestTokens } = require('../utils/supabaseAuth');

let request;
let app;
let createPatient;
let createDietician;
let DietPlan;
let FirstConsultation;
let DietPlanRequest;
let config;

beforeAll(async () => {
  await connectTestDb();
  request = require('supertest');
  app = require('../config/createApp')();
  ({ createPatient, createDietician } = require('./helpers/factories'));
  ({ DietPlan, FirstConsultation, DietPlanRequest } = require('../models'));
  config = require('../config/environment');
});

afterEach(async () => {
  clearTestTokens();
  await clearTestDb();
});

afterAll(async () => {
  await disconnectTestDb();
});

const auth = (req) => req.set('Authorization', 'Bearer dietician-token');

test('config captured DIET_PLAN_DATA_MODEL=plan-item for this test file', () => {
  expect(config.dietPlanDataModel).toBe('plan-item');
});

test('creating a diet plan with the flag on produces a plan-item plan and skips the old generation engine', async () => {
  const dietician = await createDietician();
  const patient = await createPatient();
  registerTestToken('dietician-token', dietician._id);

  const dietPlanRequest = await DietPlanRequest.create({
    patient: patient._id,
    dieticianId: dietician._id,
    startDateForDiet: new Date(),
    fullName: 'Test Patient',
    membershipPlan: 'Silver Membership',
    status: 'Paid',
  });
  const firstConsultation = await FirstConsultation.create({ patient: patient._id, dietician: dietician._id });

  const res = await auth(request(app).post(`/api/dietician/patients/${patient._id}/diet-plans/generate`)).send({
    requestId: dietPlanRequest._id.toString(),
    firstConsultationId: firstConsultation._id.toString(),
    calorieStrategy: { calorieBudget: 1800 },
    macroStrategy: {},
  });

  expect(res.status).toBe(201);
  expect(res.body.data.dataModel).toBe('plan-item');
  expect(res.body.data.workflowStatus).toBe('targets_set');
  // The old engine's output must NOT be present - it was never called.
  expect(res.body.data.generatedPlan).toBeUndefined();

  const saved = await DietPlan.findById(res.body.data.dietPlanId);
  expect(saved.dataModel).toBe('plan-item');
  expect(saved.workflowStatus).toBe('targets_set');
  expect(saved.generatedPlan).toBeFalsy();
});
