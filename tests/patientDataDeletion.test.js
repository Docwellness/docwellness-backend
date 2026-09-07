const mongoose = require('mongoose');
const { connectTestDb, disconnectTestDb, clearTestDb } = require('./helpers/testDb');

jest.mock('../utils/supabaseAuth');
const {
  registerTestToken,
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

/**
 * One row in every collection the deletion cascade covers, for `patient`.
 * Returns the created diet plan (handy for status assertions).
 */
async function seedPatientData(patient, dietician) {
  const {
    MealLog,
    WaterLog,
    Progress,
    ExerciseLog,
    Notification,
    DietPlan,
    DayPlan,
    MealSlotPlan,
    PlanItem,
    Goal,
    Milestone,
    MilestoneTask,
    CheckIn,
    Nudge,
    Review,
    FirstConsultation,
    ManualPaymentProof,
    Chat,
    Conversation,
    CustomFoodRequest,
  } = models;

  await MealLog.create({ patientId: patient._id, date: new Date(), dayKey: '2026-09-01', meals: [] });
  await WaterLog.create({ patientId: patient._id, date: '2026-09-01' });
  await Progress.create({ patientId: patient._id, date: new Date(), weight: 70 });
  await ExerciseLog.create({ patientId: patient._id, date: new Date(), exercises: [] });
  await Notification.create({ userId: patient._id, title: 'Hi', message: 'There' });
  await CustomFoodRequest.create({
    patientId: patient._id,
    dieticianId: dietician._id,
    date: new Date(),
    servingTime: 'Breakfast',
    foodName: 'Poha',
  });

  const plan = await DietPlan.create({
    patientId: patient._id,
    dieticianId: dietician._id,
    status: 'Active',
    startDate: new Date(),
  });
  const day = await DayPlan.create({
    dietPlanId: plan._id,
    patientId: patient._id,
    week: 1,
    dayGroup: 'Monday',
  });
  const slot = await MealSlotPlan.create({ dayPlanId: day._id, servingTime: 'Breakfast' });
  await PlanItem.create({ mealSlotId: slot._id, recipeVersionId: new mongoose.Types.ObjectId() });

  const goal = await Goal.create({
    patientId: patient._id,
    dieticianId: dietician._id,
    title: 'Lose weight',
    targetValue: 64,
    startDate: new Date(),
    endDate: new Date(Date.now() + 7 * 864e5),
  });
  const milestone = await Milestone.create({
    goalId: goal._id,
    type: 'weekly',
    title: 'Week 1',
    date: new Date(),
    sortOrder: 0,
  });
  const task = await MilestoneTask.create({ milestoneId: milestone._id, title: 'Log every meal' });
  await CheckIn.create({ patientId: patient._id, taskId: task._id, milestoneId: milestone._id });

  await Nudge.create({
    patientId: patient._id,
    dieticianId: dietician._id,
    message: 'Keep going',
  });
  await Review.create({ dieticianId: dietician._id, patientId: patient._id, rating: 5 });
  await FirstConsultation.create({ patient: patient._id, dietician: dietician._id });
  const conversation = await Conversation.create({
    participants: [{ userId: patient._id }, { userId: dietician._id }],
  });
  await Chat.create({
    conversationId: conversation._id,
    senderId: patient._id,
    receiverId: dietician._id,
    message: 'Hello',
  });
  await ManualPaymentProof.create({
    patient: patient._id,
    request: new mongoose.Types.ObjectId(),
    amountReceived: 100,
    amountPending: 0,
  });

  return plan;
}

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
    expect(await models.Goal.countDocuments({ patientId: patient._id })).toBe(0);
    expect(await models.ExerciseLog.countDocuments({ patientId: patient._id })).toBe(0);
    expect(await models.Chat.countDocuments({ senderId: patient._id })).toBe(0);
    expect(await models.DietPlanRequest.countDocuments({ patient: patient._id })).toBe(0);
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

describe('DELETE /api/dietician/patients/:patientId (regression - full cascade)', () => {
  test('now also clears ExerciseLog, the Goal chain and the DayPlan chain', async () => {
    const { dietician, patient } = await seedOwnedPatient();
    await seedPatientData(patient, dietician);
    registerTestToken('d', dietician._id);

    const res = await request(app)
      .delete(`/api/dietician/patients/${patient._id}`)
      .set(authed('d'))
      .send({ confirmEmail: patient.email });

    expect(res.status).toBe(200);
    expect(await models.User.findById(patient._id)).toBeNull();
    expect(await models.ExerciseLog.countDocuments({ patientId: patient._id })).toBe(0);
    expect(await models.Goal.countDocuments({ patientId: patient._id })).toBe(0);
    expect(await models.Milestone.countDocuments({})).toBe(0);
    expect(await models.MilestoneTask.countDocuments({})).toBe(0);
    expect(await models.DayPlan.countDocuments({ patientId: patient._id })).toBe(0);
    expect(await models.CheckIn.countDocuments({ patientId: patient._id })).toBe(0);
    expect(getDeletedSupabaseUserIds()).toContain(String(patient.supabaseUserId));
  });
});
