/**
 * A diet plan is created without a start date or week dates (startDatePending)
 * and is dated when the payment is approved (see activatePendingPlan.test.js).
 * This file covers creation, the 409 guards that stop the date being set any
 * other way, and the readers that run on a plan before it has dates.
 */
process.env.DIET_PLAN_DATA_MODEL = 'plan-item';

const { connectTestDb, disconnectTestDb, clearTestDb } = require('./helpers/testDb');

jest.mock('../utils/supabaseAuth');
const { registerTestToken, clearTestTokens } = require('../utils/supabaseAuth');

let request;
let app;
let createPatient;
let createDietician;
let createDietPlanRequest;
let createActiveDietPlan;
let DietPlan;
let DietPlanRequest;
let FirstConsultation;
let ManualPaymentProof;
let Recipe;
let User;

beforeAll(async () => {
  await connectTestDb();
  request = require('supertest');
  app = require('../config/createApp')();
  ({ createPatient, createDietician, createDietPlanRequest, createActiveDietPlan } = require('./helpers/factories'));
  ({ DietPlan, DietPlanRequest, FirstConsultation, ManualPaymentProof, Recipe, User } = require('../models'));
});

afterEach(async () => {
  clearTestTokens();
  await clearTestDb();
});

afterAll(async () => {
  await disconnectTestDb();
});

const auth = (req) => req.set('Authorization', 'Bearer dietician-token');
const base = (patient) => `/api/dietician/patients/${patient._id}`;
const REQUESTED_START = new Date('2026-11-16T00:00:00.000Z');

async function setup() {
  const dietician = await createDietician();
  const patient = await createPatient();
  registerTestToken('dietician-token', dietician._id);
  const dietPlanRequest = await createDietPlanRequest(patient, dietician, {
    status: 'Unpaid',
    membershipPlan: 'Silver Membership',
    startDateForDiet: REQUESTED_START,
  });
  return { dietician, patient, dietPlanRequest };
}

async function createPlanThroughApi({ dietician, patient, dietPlanRequest }, body = {}) {
  const firstConsultation = await FirstConsultation.create({ patient: patient._id, dietician: dietician._id });
  return auth(request(app).post(`${base(patient)}/diet-plans/generate`)).send({
    requestId: dietPlanRequest._id.toString(),
    firstConsultationId: firstConsultation._id.toString(),
    calorieStrategy: { calorieBudget: 2000 },
    macroStrategy: {},
    ...body,
  });
}

describe('creating a plan', () => {
  test('is created pending, with no start date and an empty schedule, even when a startDate is sent', async () => {
    const ctx = await setup();
    const res = await createPlanThroughApi(ctx, { startDate: '2030-01-01' });

    expect(res.status).toBe(201);
    expect(res.body.data.weekSchedule).toEqual([]);
    const plan = await DietPlan.findById(res.body.data.dietPlanId);
    expect(plan.startDatePending).toBe(true);
    expect(plan.startDate).toBeUndefined();
    expect(plan.weekSchedule).toHaveLength(0);
  });

  test('does not touch the request start date or subscription fields', async () => {
    const ctx = await setup();
    await createPlanThroughApi(ctx);

    const saved = await DietPlanRequest.findById(ctx.dietPlanRequest._id);
    expect(saved.startDateForDiet.toISOString()).toBe(REQUESTED_START.toISOString());
    expect(saved.subscriptionStartDate).toBeFalsy();
    expect(saved.subscriptionExpiresAt).toBeFalsy();
  });
});

describe('start date edits while the plan is pending', () => {
  async function pendingPlan() {
    const ctx = await setup();
    const res = await createPlanThroughApi(ctx);
    return { ...ctx, planId: res.body.data.dietPlanId };
  }

  test('the profile start-date edit answers 409 and changes nothing', async () => {
    const { patient, dietPlanRequest, planId } = await pendingPlan();
    const res = await auth(request(app).patch(`${base(patient)}/diet-start-date`)).send({ startDate: '2030-01-01' });

    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/payment is approved/i);
    expect((await DietPlanRequest.findById(dietPlanRequest._id)).startDateForDiet.toISOString()).toBe(
      REQUESTED_START.toISOString()
    );
    expect((await DietPlan.findById(planId)).weekSchedule).toHaveLength(0);
  });

  test('the single-week reschedule answers 409 and changes nothing', async () => {
    const { patient, planId } = await pendingPlan();
    const res = await auth(request(app).patch(`${base(patient)}/diet-plans/${planId}/weeks/1/schedule`)).send({
      startDate: '2030-01-01',
    });

    expect(res.status).toBe(409);
    expect((await DietPlan.findById(planId)).weekSchedule).toHaveLength(0);
  });

  test('both still work for a plan that is not pending', async () => {
    const dietician = await createDietician();
    const patient = await createPatient();
    registerTestToken('dietician-token', dietician._id);
    await createDietPlanRequest(patient, dietician);
    const plan = await createActiveDietPlan(patient, dietician, {
      weekSchedule: [{ week: 1, startDate: new Date('2030-01-01'), endDate: new Date('2030-01-07') }],
    });

    const profileEdit = await auth(request(app).patch(`${base(patient)}/diet-start-date`)).send({
      startDate: '2030-02-01',
    });
    expect(profileEdit.status).toBe(200);

    const weekEdit = await auth(request(app).patch(`${base(patient)}/diet-plans/${plan._id}/weeks/1/schedule`)).send({
      startDate: '2030-03-01',
    });
    expect(weekEdit.status).toBe(200);
  });
});

describe('profile start-date edit during a renewal', () => {
  const RUNNING_START = new Date('2030-01-01T00:00:00.000Z');
  const PREFERRED_RENEWAL_START = new Date('2030-03-15T00:00:00.000Z');
  const NEW_DAY = '2030-02-01';
  // The route reads the day with the server's local midnight, so the test does too.
  const parsedNewDay = () => {
    const parsed = new Date(NEW_DAY);
    parsed.setHours(0, 0, 0, 0);
    return parsed;
  };
  const DAY_MS = 24 * 60 * 60 * 1000;

  async function runningPlanWithRenewal({ renewalStatus = 'Finalized' } = {}) {
    const { buildWeekSchedule } = require('../utils/weekSchedule');
    const { ExercisePlan } = require('../models');
    const dietician = await createDietician();
    const patient = await createPatient();
    registerTestToken('dietician-token', dietician._id);
    const dietPlanRequest = await createDietPlanRequest(patient, dietician, {
      status: 'PaymentSubmitted',
      startDateForDiet: PREFERRED_RENEWAL_START,
    });
    const running = await createActiveDietPlan(patient, dietician, {
      request: dietPlanRequest._id,
      cycleNumber: 1,
      weekSchedule: buildWeekSchedule(RUNNING_START),
    });
    const renewal = await DietPlan.create({
      patientId: patient._id,
      dieticianId: dietician._id,
      request: dietPlanRequest._id,
      status: renewalStatus,
      cycleNumber: 2,
      startDatePending: true,
    });
    const exercisePlan = await ExercisePlan.create({
      patientId: patient._id,
      dieticianId: dietician._id,
      status: 'Active',
      startDate: RUNNING_START,
    });
    const proof = await ManualPaymentProof.create({
      request: dietPlanRequest._id,
      patient: patient._id,
      amountReceived: 5000,
      amountPending: 0,
      status: 'Submitted',
    });
    await DietPlanRequest.updateOne({ _id: dietPlanRequest._id }, { latestPaymentProof: proof._id });
    await User.updateOne(
      { _id: patient._id },
      { $set: { 'status.activeDietPlanId': running._id, 'status.pendingDietPlanId': renewal._id } }
    );
    return { dietician, patient, dietPlanRequest, running, renewal, exercisePlan, proof, ExercisePlan };
  }

  const edit = (patient, startDate = NEW_DAY) =>
    auth(request(app).patch(`${base(patient)}/diet-start-date`)).send({ startDate });

  test('a later day moves the running plan weeks and the exercise plan', async () => {
    const { patient, running, exercisePlan, ExercisePlan } = await runningPlanWithRenewal();
    const res = await edit(patient);

    expect(res.status).toBe(200);
    expect(new Date(res.body.data.startDateForDiet).toISOString()).toBe(parsedNewDay().toISOString());
    const weeks = (await DietPlan.findById(running._id)).weekSchedule;
    expect(weeks[0].startDate.toISOString()).toBe(parsedNewDay().toISOString());
    expect(weeks[3].endDate.getTime() - weeks[0].startDate.getTime()).toBe(27 * DAY_MS);
    expect((await ExercisePlan.findById(exercisePlan._id)).startDate.toISOString()).toBe(parsedNewDay().toISOString());
  });

  test.each(['Finalized', 'Draft'])(
    'leaves the %s renewal plan, the request, the subscription dates and the proof unchanged',
    async (renewalStatus) => {
      const { patient, renewal, dietPlanRequest, proof } = await runningPlanWithRenewal({ renewalStatus });
      const requestBefore = (await DietPlanRequest.findById(dietPlanRequest._id)).toObject();

      const res = await edit(patient);

      expect(res.status).toBe(200);
      const renewalAfter = await DietPlan.findById(renewal._id);
      expect(renewalAfter.status).toBe(renewalStatus);
      expect(renewalAfter.startDatePending).toBe(true);
      expect(renewalAfter.weekSchedule).toHaveLength(0);
      const requestAfter = (await DietPlanRequest.findById(dietPlanRequest._id)).toObject();
      expect(requestAfter.startDateForDiet).toEqual(requestBefore.startDateForDiet);
      expect(requestAfter.startDateForDiet.toISOString()).toBe(PREFERRED_RENEWAL_START.toISOString());
      expect(requestAfter.subscriptionStartDate).toEqual(requestBefore.subscriptionStartDate);
      expect(requestAfter.subscriptionExpiresAt).toEqual(requestBefore.subscriptionExpiresAt);
      expect(requestAfter.status).toBe('PaymentSubmitted');
      const proofAfter = await ManualPaymentProof.findById(proof._id);
      expect(proofAfter.status).toBe('Submitted');
      expect(proofAfter.amountReceived).toBe(5000);
    }
  );

  test('a day before today is refused and nothing changes', async () => {
    const { patient, running, exercisePlan, ExercisePlan } = await runningPlanWithRenewal();
    const res = await edit(patient, '2020-01-01');

    expect(res.status).toBe(400);
    expect((await DietPlan.findById(running._id)).weekSchedule[0].startDate.toISOString()).toBe(RUNNING_START.toISOString());
    expect((await ExercisePlan.findById(exercisePlan._id)).startDate.toISOString()).toBe(RUNNING_START.toISOString());
  });

  test('the renewal earliest day follows the moved running plan', async () => {
    const planEnd = require('../utils/planEnd');
    const { addDaysToDay } = require('../utils/planStartDate');
    const { patient, renewal } = await runningPlanWithRenewal();
    await edit(patient);

    const newEnd = (await planEnd.loadPlanEnd(patient._id)).endDay;
    const res = await auth(
      request(app).get(`${base(patient)}/diet-plans/${renewal._id}/start-date-options`)
    );

    expect(res.status).toBe(200);
    expect(res.body.data.runningCycleEndDate).toBe(newEnd);
    expect(res.body.data.minDate).toBe(addDaysToDay(newEnd, 1));
  });

  test('the profile shows the running plan week 1 start, not the renewal preference', async () => {
    const { patient } = await runningPlanWithRenewal();
    await edit(patient);
    const moved = parsedNewDay();
    const expected = [
      String(moved.getDate()).padStart(2, '0'),
      String(moved.getMonth() + 1).padStart(2, '0'),
      moved.getFullYear(),
    ].join('-');

    const res = await auth(request(app).get(`${base(patient)}/profile`));

    expect(res.status).toBe(200);
    expect(res.body.data.healthSummary.startDateForDiet).toBe(expected);
  });

  test('a first-time pending plan with no running plan still answers 409 and changes nothing', async () => {
    const ctx = await setup();
    const created = await createPlanThroughApi(ctx);
    const res = await edit(ctx.patient);

    expect(res.status).toBe(409);
    expect((await DietPlan.findById(created.body.data.dietPlanId)).weekSchedule).toHaveLength(0);
    expect((await DietPlanRequest.findById(ctx.dietPlanRequest._id)).startDateForDiet.toISOString()).toBe(
      REQUESTED_START.toISOString()
    );
  });
});

describe('renewal confirmation guard', () => {
  async function renewalWithProof({ pending, pendingStatus = 'Finalized' }) {
    const dietician = await createDietician();
    const patient = await createPatient();
    registerTestToken('dietician-token', dietician._id);
    const dietPlanRequest = await createDietPlanRequest(patient, dietician, { status: 'PaymentSubmitted' });
    await createActiveDietPlan(patient, dietician);
    if (pending) {
      await DietPlan.create({
        patientId: patient._id,
        dieticianId: dietician._id,
        request: dietPlanRequest._id,
        status: pendingStatus,
        cycleNumber: 2,
        startDatePending: true,
      });
    }
    const proof = await ManualPaymentProof.create({
      request: dietPlanRequest._id,
      patient: patient._id,
      amountReceived: 5000,
      amountPending: 0,
      status: 'Submitted',
    });
    const res = await auth(request(app).put(`${base(patient)}/payments/manual-proofs/${proof._id}/confirm`));
    return { res, proof, dietPlanRequest };
  }

  test('is refused with needs_plan_activation while a not-started plan exists, and the proof stays Submitted', async () => {
    const { res, proof, dietPlanRequest } = await renewalWithProof({ pending: true });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('needs_plan_activation');
    expect((await ManualPaymentProof.findById(proof._id)).status).toBe('Submitted');
    expect((await DietPlanRequest.findById(dietPlanRequest._id)).status).toBe('PaymentSubmitted');
  });

  test('is refused with needs_plan_activation for an unfinalized draft too', async () => {
    const { res, proof, dietPlanRequest } = await renewalWithProof({ pending: true, pendingStatus: 'Draft' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('needs_plan_activation');
    expect((await ManualPaymentProof.findById(proof._id)).status).toBe('Submitted');
    expect((await DietPlanRequest.findById(dietPlanRequest._id)).status).toBe('PaymentSubmitted');
  });

  test('still settles the bill when no plan is waiting for a start date', async () => {
    const { res, proof, dietPlanRequest } = await renewalWithProof({ pending: false });

    expect(res.status).toBe(200);
    expect((await ManualPaymentProof.findById(proof._id)).status).toBe('Approved');
    expect((await DietPlanRequest.findById(dietPlanRequest._id)).status).toBe('Paid');
  });
});

describe('readers on a plan with an empty schedule', () => {
  async function seedRecipes(dietician) {
    for (const servingTime of ['Morning Drink', 'Breakfast', 'Brunch', 'Lunch', 'Evening Snack', 'Dinner', 'Night Drink']) {
      await Recipe.create({
        dieticianId: dietician._id,
        name: `${servingTime} Dish`,
        servingTime,
        components: [{ label: `${servingTime} Dish`, quantity: 100, unit: 'g' }],
        ingredients: [{ name: 'Oats', quantity: 100, unit: 'g' }],
        nutrition: { calories: 300, protein: 10, carbs: 30, fats: 5, fiber: 3 },
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 600)); // let the post-save recipe syncs land
  }

  test('generate-menu and finalize succeed for a pending plan', async () => {
    const ctx = await setup();
    await seedRecipes(ctx.dietician);
    const created = await createPlanThroughApi(ctx);
    const planId = created.body.data.dietPlanId;

    const generated = await auth(request(app).post(`${base(ctx.patient)}/diet-plans/${planId}/generate-menu`)).send({
      weekNumbers: [1],
    });
    expect(generated.status).toBe(200);

    const balanced = await auth(request(app).post(`${base(ctx.patient)}/diet-plans/${planId}/auto-balance`)).send({
      scope: 'week',
      week: 1,
      targetDailyCalories: 2000,
    });
    expect(balanced.status).toBe(200);

    const finalized = await auth(
      request(app).post(`${base(ctx.patient)}/diet-plans/${planId}/finalize-plan-item-week`)
    ).send({});
    expect(finalized.status).toBe(200);

    const plan = await DietPlan.findById(planId);
    expect(plan.status).toBe('Finalized');
    expect(plan.startDatePending).toBe(true);
    expect(plan.weekSchedule).toHaveLength(0);
  });

  test('the dietician profile builds with no week dates and says the start is pending', async () => {
    const ctx = await setup();
    const created = await createPlanThroughApi(ctx);
    await User.updateOne({ _id: ctx.patient._id }, { $set: { 'status.activeDietPlanId': created.body.data.dietPlanId } });

    const res = await auth(request(app).get(`${base(ctx.patient)}/profile`));

    expect(res.status).toBe(200);
    expect(res.body.data.weekSchedule).toEqual([]);
    expect(res.body.data.status.startDatePending).toBe(true);
  });

  test('the dietician profile of a plan with dates is not pending', async () => {
    const dietician = await createDietician();
    const patient = await createPatient();
    registerTestToken('dietician-token', dietician._id);
    await createDietPlanRequest(patient, dietician);
    const plan = await createActiveDietPlan(patient, dietician);
    await User.updateOne({ _id: patient._id }, { $set: { 'status.activeDietPlanId': plan._id } });

    const res = await auth(request(app).get(`${base(patient)}/profile`));

    expect(res.status).toBe(200);
    expect(res.body.data.status.startDatePending).toBe(false);
  });

  test('the dietician profile sends the activation date of an activated plan, apart from the start day', async () => {
    const dietician = await createDietician();
    const patient = await createPatient();
    registerTestToken('dietician-token', dietician._id);
    await createDietPlanRequest(patient, dietician);
    const plan = await createActiveDietPlan(patient, dietician);
    const approvedAt = new Date('2026-11-20T10:52:00.000Z');
    await DietPlan.updateOne({ _id: plan._id }, { $set: { activationDate: approvedAt } });
    await User.updateOne({ _id: patient._id }, { $set: { 'status.activeDietPlanId': plan._id } });

    const res = await auth(request(app).get(`${base(patient)}/profile`));

    expect(res.status).toBe(200);
    expect(res.body.data.healthSummary.activationDate).toBe(approvedAt.toISOString());
  });

  test('the dietician profile has no activation date while the plan is still pending', async () => {
    const ctx = await setup();
    const created = await createPlanThroughApi(ctx);
    await User.updateOne({ _id: ctx.patient._id }, { $set: { 'status.activeDietPlanId': created.body.data.dietPlanId } });

    const res = await auth(request(app).get(`${base(ctx.patient)}/profile`));

    expect(res.status).toBe(200);
    expect(res.body.data.healthSummary.activationDate).toBeNull();
  });

  describe('pendingCycle.startDatePending', () => {
    async function profileWithRenewal({ renewalPending }) {
      const dietician = await createDietician();
      const patient = await createPatient();
      registerTestToken('dietician-token', dietician._id);
      const dietPlanRequest = await createDietPlanRequest(patient, dietician);
      const running = await createActiveDietPlan(patient, dietician, { request: dietPlanRequest._id });
      const renewal = await DietPlan.create({
        patientId: patient._id,
        dieticianId: dietician._id,
        request: dietPlanRequest._id,
        status: 'Finalized',
        cycleNumber: 2,
        startDatePending: renewalPending,
      });
      await User.updateOne(
        { _id: patient._id },
        { $set: { 'status.activeDietPlanId': running._id, 'status.pendingDietPlanId': renewal._id } }
      );
      return auth(request(app).get(`${base(patient)}/profile`));
    }

    test('is true for a renewal that has no start date yet, while the running plan is not pending', async () => {
      const res = await profileWithRenewal({ renewalPending: true });

      expect(res.status).toBe(200);
      expect(res.body.data.pendingCycle.startDatePending).toBe(true);
      expect(res.body.data.status.startDatePending).toBe(true);
    });

    test('is false for a renewal that already has its dates', async () => {
      const res = await profileWithRenewal({ renewalPending: false });

      expect(res.status).toBe(200);
      expect(res.body.data.pendingCycle.startDatePending).toBe(false);
      expect(res.body.data.status.startDatePending).toBe(false);
    });
  });
});
