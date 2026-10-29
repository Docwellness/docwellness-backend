const { connectTestDb, disconnectTestDb, clearTestDb } = require('./helpers/testDb');
const { seedPatientData } = require('./helpers/seedPatientData');

jest.mock('../utils/supabaseAuth');
const {
  registerTestToken,
  registerTestCredentials,
  clearTestTokens,
  getDeletedSupabaseUserIds,
} = require('../utils/supabaseAuth');

let request;
let app;
let factories;
let models;

beforeAll(async () => {
  await connectTestDb();
  request = require('supertest');
  app = require('../config/createApp')();
  factories = require('./helpers/factories');
  models = require('../models');
});

afterEach(async () => {
  clearTestTokens();
  await clearTestDb();
});

afterAll(async () => {
  await disconnectTestDb();
});

async function seedOwnedPatient(overrides = {}) {
  const dietician = await factories.createDietician();
  const patient = await factories.createPatient(overrides);
  await factories.createDietPlanRequest(patient, dietician);
  return { dietician, patient };
}

const authed = (token) => ({ Authorization: `Bearer ${token}` });

describe('DELETE /api/dietician/patients/:patientId/data', () => {
  test('deletes only the selected categories, keeps the account and other data', async () => {
    const { dietician, patient } = await seedOwnedPatient();
    await seedPatientData(patient, dietician);
    registerTestToken('d', dietician._id);

    const res = await request(app)
      .delete(`/api/dietician/patients/${patient._id}/data`)
      .set(authed('d'))
      .send({ confirmEmail: patient.email, categories: ['mealLog', 'waterLog'], deleteAccount: false });

    expect(res.status).toBe(200);
    expect(res.body.data.accountDeleted).toBe(false);

    expect(await models.MealLog.countDocuments({ patientId: patient._id })).toBe(0);
    expect(await models.WaterLog.countDocuments({ patientId: patient._id })).toBe(0);
    // untouched
    expect(await models.Progress.countDocuments({ patientId: patient._id })).toBe(1);
    expect(await models.DietPlan.countDocuments({ patientId: patient._id })).toBe(1);
    expect(await models.Goal.countDocuments({ patientId: patient._id })).toBe(1);
    expect(await models.User.findById(patient._id)).not.toBeNull();
  });

  test('dietPlan category also removes the DayPlan/MealSlotPlan/PlanItem chain and clears status', async () => {
    const { dietician, patient } = await seedOwnedPatient();
    const plan = await seedPatientData(patient, dietician);
    await models.User.updateOne(
      { _id: patient._id },
      { $set: { 'status.activeDietPlanId': plan._id } }
    );
    registerTestToken('d', dietician._id);

    const res = await request(app)
      .delete(`/api/dietician/patients/${patient._id}/data`)
      .set(authed('d'))
      .send({ confirmEmail: patient.email, categories: ['dietPlan'], deleteAccount: false });

    expect(res.status).toBe(200);
    expect(await models.DietPlan.countDocuments({ patientId: patient._id })).toBe(0);
    expect(await models.DayPlan.countDocuments({ patientId: patient._id })).toBe(0);
    expect(await models.MealSlotPlan.countDocuments({})).toBe(0);
    expect(await models.PlanItem.countDocuments({})).toBe(0);

    const updated = await models.User.findById(patient._id);
    expect(updated.status.activeDietPlanId).toBeNull();
  });

  test('deleteAccount:true wipes everything, the User, and the Supabase identity', async () => {
    const { dietician, patient } = await seedOwnedPatient();
    await seedPatientData(patient, dietician);
    registerTestToken('d', dietician._id);

    const res = await request(app)
      .delete(`/api/dietician/patients/${patient._id}/data`)
      .set(authed('d'))
      .send({ confirmEmail: patient.email, categories: [], deleteAccount: true });

    expect(res.status).toBe(200);
    expect(res.body.data.accountDeleted).toBe(true);

    expect(await models.User.findById(patient._id)).toBeNull();
    expect(await models.MealLog.countDocuments({ patientId: patient._id })).toBe(0);
    expect(await models.ExerciseLog.countDocuments({ patientId: patient._id })).toBe(0);
    expect(await models.Chat.countDocuments({ senderId: patient._id })).toBe(0);
    expect(await models.DietPlanRequest.countDocuments({ patient: patient._id })).toBe(0);
    // the id-chained collections (no direct patientId) are cleared too
    expect(await models.Goal.countDocuments({ patientId: patient._id })).toBe(0);
    expect(await models.Milestone.countDocuments({})).toBe(0);
    expect(await models.MilestoneTask.countDocuments({})).toBe(0);
    expect(await models.DayPlan.countDocuments({ patientId: patient._id })).toBe(0);
    expect(await models.MealSlotPlan.countDocuments({})).toBe(0);
    expect(await models.PlanItem.countDocuments({})).toBe(0);
    expect(await models.CheckIn.countDocuments({ patientId: patient._id })).toBe(0);
    expect(getDeletedSupabaseUserIds()).toContain(String(patient.supabaseUserId));
  });

  test("403s when the patient isn't this dietician's own", async () => {
    const { patient } = await seedOwnedPatient();
    const otherDietician = await factories.createDietician();
    registerTestToken('other', otherDietician._id);

    const res = await request(app)
      .delete(`/api/dietician/patients/${patient._id}/data`)
      .set(authed('other'))
      .send({ confirmEmail: patient.email, categories: ['mealLog'], deleteAccount: false });

    expect(res.status).toBe(403);
  });

  test('400s on a mismatched confirmEmail', async () => {
    const { dietician, patient } = await seedOwnedPatient();
    registerTestToken('d', dietician._id);

    const res = await request(app)
      .delete(`/api/dietician/patients/${patient._id}/data`)
      .set(authed('d'))
      .send({ confirmEmail: 'wrong@example.test', categories: ['mealLog'], deleteAccount: false });

    expect(res.status).toBe(400);
  });

  test('400s on an unknown category', async () => {
    const { dietician, patient } = await seedOwnedPatient();
    registerTestToken('d', dietician._id);

    const res = await request(app)
      .delete(`/api/dietician/patients/${patient._id}/data`)
      .set(authed('d'))
      .send({ confirmEmail: patient.email, categories: ['bogus'], deleteAccount: false });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/unknown data category/i);
  });

  test('400s when dietPlanRequest is selected without deleteAccount', async () => {
    const { dietician, patient } = await seedOwnedPatient();
    registerTestToken('d', dietician._id);

    const res = await request(app)
      .delete(`/api/dietician/patients/${patient._id}/data`)
      .set(authed('d'))
      .send({ confirmEmail: patient.email, categories: ['dietPlanRequest'], deleteAccount: false });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/only be removed together with the account/i);
  });

  test('400s when nothing is selected and no account delete', async () => {
    const { dietician, patient } = await seedOwnedPatient();
    registerTestToken('d', dietician._id);

    const res = await request(app)
      .delete(`/api/dietician/patients/${patient._id}/data`)
      .set(authed('d'))
      .send({ confirmEmail: patient.email, categories: [], deleteAccount: false });

    expect(res.status).toBe(400);
  });
});

describe('patient self-service deletion', () => {
  const PASSWORD = 'correct-horse';

  async function setup() {
    const { dietician, patient } = await seedOwnedPatient();
    await seedPatientData(patient, dietician);
    registerTestToken('p', patient._id);
    registerTestCredentials(patient.email, PASSWORD, {});
    return { dietician, patient };
  }

  test('lists deletable categories without the account-only one', async () => {
    const { patient } = await setup();
    const res = await request(app).get('/api/patient/data-deletion/categories').set(authed('p'));
    expect(res.status).toBe(200);
    const keys = res.body.data.categories.map((c) => c.key);
    expect(keys).toContain('mealLog');
    expect(keys).not.toContain('dietPlanRequest');
    expect(await models.User.findById(patient._id)).not.toBeNull();
  });

  test('rejects a wrong password and deletes nothing', async () => {
    const { patient } = await setup();
    const res = await request(app)
      .post('/api/patient/data-deletion')
      .set(authed('p'))
      .send({ password: 'nope', categories: ['mealLog'] });
    expect(res.status).toBe(401);
    expect(await models.MealLog.countDocuments({ patientId: patient._id })).toBe(1);
  });

  test('deletes only the selected categories', async () => {
    const { patient } = await setup();
    const res = await request(app)
      .post('/api/patient/data-deletion')
      .set(authed('p'))
      .send({ password: PASSWORD, categories: ['mealLog', 'chat'] });
    expect(res.status).toBe(200);
    expect(res.body.data.accountDeleted).toBe(false);
    expect(await models.MealLog.countDocuments({ patientId: patient._id })).toBe(0);
    expect(await models.Chat.countDocuments({ senderId: patient._id })).toBe(0);
    expect(await models.Progress.countDocuments({ patientId: patient._id })).toBe(1);
    expect(await models.User.findById(patient._id)).not.toBeNull();
  });

  test('rejects empty selection and the account-only category', async () => {
    await setup();
    const empty = await request(app)
      .post('/api/patient/data-deletion')
      .set(authed('p'))
      .send({ password: PASSWORD, categories: [] });
    expect(empty.status).toBe(400);
    const accountOnly = await request(app)
      .post('/api/patient/data-deletion')
      .set(authed('p'))
      .send({ password: PASSWORD, categories: ['dietPlanRequest'] });
    expect(accountOnly.status).toBe(400);
  });

  test('deleteAccount:true wipes all data, the user and the Supabase identity', async () => {
    const { patient } = await setup();
    const res = await request(app)
      .post('/api/patient/data-deletion')
      .set(authed('p'))
      .send({ password: PASSWORD, deleteAccount: true });
    expect(res.status).toBe(200);
    expect(res.body.data.accountDeleted).toBe(true);
    expect(await models.User.findById(patient._id)).toBeNull();
    expect(await models.MealLog.countDocuments({ patientId: patient._id })).toBe(0);
    expect(await models.Chat.countDocuments({})).toBe(0);
  });

  test('legacy DELETE /profile now cascades too', async () => {
    const { patient } = await setup();
    const res = await request(app)
      .delete('/api/patient/profile')
      .set(authed('p'))
      .send({ password: PASSWORD });
    expect(res.status).toBe(200);
    expect(await models.User.findById(patient._id)).toBeNull();
    expect(await models.Progress.countDocuments({ patientId: patient._id })).toBe(0);
  });
});
