/**
 * Before the payment is approved a plan has no dated weeks, so the "last 2
 * days of the prior week" wait cannot be checked. generate-week therefore
 * answers 409 week_locked_until_activation for anything but Week 1 on a plan
 * that is still waiting for its start date (startDatePending), and the wait
 * returns on its own once activation dates the weeks. Old-flow plans are
 * untouched. The generator is stubbed: only the gate is under test.
 */
jest.mock('../utils/supabaseAuth');
jest.mock('../services/dietPlanGenerationService', () => ({
  generateWeekPlan: jest.fn().mockResolvedValue({ ok: true }),
}));

const { connectTestDb, disconnectTestDb, clearTestDb } = require('./helpers/testDb');
const { registerTestToken, clearTestTokens } = require('../utils/supabaseAuth');
const { generateWeekPlan } = require('../services/dietPlanGenerationService');

let request;
let app;
let createPatient;
let createDietician;
let createDietPlanRequest;
let createActiveDietPlan;
let DietPlan;
let FirstConsultation;
let ManualPaymentProof;
let Progress;
let planEnd;
let validateRegenerateRequest;
let buildWeekSchedule;

const LOCK_CODE = 'week_locked_until_activation';
const LOCK_MESSAGE = 'Weeks after Week 1 open once the payment is approved and the start date is set.';

beforeAll(async () => {
  await connectTestDb();
  request = require('supertest');
  app = require('../config/createApp')();
  ({ createPatient, createDietician, createDietPlanRequest, createActiveDietPlan } = require('./helpers/factories'));
  ({ DietPlan, FirstConsultation, ManualPaymentProof, Progress } = require('../models'));
  planEnd = require('../utils/planEnd');
  ({ validateRegenerateRequest } = require('../utils/membershipTiers'));
  ({ buildWeekSchedule } = require('../utils/weekSchedule'));
});

beforeEach(() => {
  generateWeekPlan.mockClear();
});

afterEach(async () => {
  clearTestTokens();
  await clearTestDb();
});

afterAll(async () => {
  await disconnectTestDb();
});

const auth = (req) => req.set('Authorization', 'Bearer dietician-token');
const planUrl = (patient, plan, suffix) => `/api/dietician/patients/${patient._id}/diet-plans/${plan._id}/${suffix}`;
const generateWeek = ({ patient, plan }, weekNumbers, extra = {}) =>
  auth(request(app).post(planUrl(patient, plan, 'generate-week'))).send({
    weekNumbers,
    calorieStrategy: { calorieBudget: 2000 },
    macroStrategy: {},
    ...extra,
  });

const finalizedThrough = (lastWeek) => ({
  weeks: Array.from({ length: lastWeek }, (_, i) => ({ week: i + 1, dailyMeals: [] })),
});

/** A plan of the given tier with `finalizedWeeks` finalized, pending or dated. */
async function seedPlan({ tier = 'Platinum', finalizedWeeks = 1, pending = true, planOverrides = {}, dataModel } = {}) {
  const dietician = await createDietician();
  const patient = await createPatient();
  registerTestToken('dietician-token', dietician._id);
  const dietPlanRequest = await createDietPlanRequest(patient, dietician, {
    status: 'PaymentSubmitted',
    membershipPlan: `${tier} Membership`,
  });
  const plan = await DietPlan.create({
    patientId: patient._id,
    dieticianId: dietician._id,
    request: dietPlanRequest._id,
    status: 'Finalized',
    cycleNumber: 1,
    startDatePending: pending,
    finalizedPlan: finalizedThrough(finalizedWeeks),
    ...(dataModel ? { dataModel } : {}),
    ...planOverrides,
  });
  return { dietician, patient, dietPlanRequest, plan };
}

describe('a plan waiting for its start date', () => {
  test('Platinum with Week 1 finalized: Week 2 is locked and nothing is written or generated', async () => {
    const seeded = await seedPlan();
    const before = await DietPlan.findById(seeded.plan._id).lean();

    const res = await generateWeek(seeded, [2], { currentWeight: 70 });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ success: false, code: LOCK_CODE, message: LOCK_MESSAGE });
    expect(generateWeekPlan).not.toHaveBeenCalled();
    expect(await Progress.countDocuments({})).toBe(0);
    const after = await DietPlan.findById(seeded.plan._id).lean();
    expect(after.calorieStrategy).toEqual(before.calorieStrategy);
    expect(after.generatedPlan).toEqual(before.generatedPlan);
    expect(after.weekSchedule).toEqual(before.weekSchedule);
  });

  test.each([[[3]], [[4]]])('Platinum Week %j is locked too', async (weekNumbers) => {
    const res = await generateWeek(await seedPlan({ finalizedWeeks: 2 }), weekNumbers);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe(LOCK_CODE);
    expect(generateWeekPlan).not.toHaveBeenCalled();
  });

  test('Golden with Week 2 finalized: Weeks 3-4 are locked', async () => {
    const res = await generateWeek(await seedPlan({ tier: 'Golden', finalizedWeeks: 2 }), [3, 4]);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe(LOCK_CODE);
    expect(generateWeekPlan).not.toHaveBeenCalled();
  });

  test('a plan-item plan is locked the same way', async () => {
    const res = await generateWeek(await seedPlan({ dataModel: 'plan-item' }), [2]);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe(LOCK_CODE);
  });

  test('Week 1 can still be generated, and the plan stays undated even when a startDate is sent', async () => {
    const seeded = await seedPlan();
    const res = await generateWeek(seeded, [1], { startDate: '2030-01-01' });

    expect(res.status).toBe(200);
    expect(generateWeekPlan).toHaveBeenCalledTimes(1);
    expect(generateWeekPlan.mock.calls[0][0].weekNumbers).toEqual([1]);
    const plan = await DietPlan.findById(seeded.plan._id);
    expect(plan.startDatePending).toBe(true);
    expect(plan.weekSchedule).toHaveLength(0);
  });

  test('once the payment is approved the lock is gone and the old window rule answers instead', async () => {
    const seeded = await seedPlan();
    const proof = await ManualPaymentProof.create({
      request: seeded.dietPlanRequest._id,
      patient: seeded.patient._id,
      amountReceived: 5000,
      amountPending: 0,
      status: 'Submitted',
    });
    await seeded.dietPlanRequest.updateOne({ latestPaymentProof: proof._id });

    const activated = await auth(request(app).post(planUrl(seeded.patient, seeded.plan, 'activate'))).send({
      startDate: planEnd.istDayKey(new Date()),
    });
    expect(activated.status).toBe(200);

    const res = await generateWeek(seeded, [2]);

    expect(res.status).toBe(403);
    expect(res.body.code).toBeUndefined();
    expect(res.body.message).toMatch(/last 2 days of Week 1/);
  });
});

describe('the helper itself', () => {
  test('validateRegenerateRequest still allows a week with no schedule entry; the controller closes the hole', () => {
    const result = validateRegenerateRequest({
      tier: 'platinum',
      weekNumbers: [2],
      existingWeekNumbers: [],
      finalizedWeekNumbers: [1],
      currentWeekSchedule: undefined,
    });

    expect(result.ok).toBe(true);
  });
});

describe('plans that are not waiting for a start date behave as before', () => {
  const dated = (endsInDays) => {
    const end = new Date(Date.now() + endsInDays * 24 * 60 * 60 * 1000);
    const start = new Date(end.getTime() - 6 * 24 * 60 * 60 * 1000);
    return buildWeekSchedule(start);
  };

  test('outside the last 2 days of the prior week Week 2 is refused with 403', async () => {
    const seeded = await seedPlan({ pending: false, planOverrides: { weekSchedule: dated(6) } });
    const res = await generateWeek(seeded, [2]);

    expect(res.status).toBe(403);
    expect(res.body.code).toBeUndefined();
    expect(generateWeekPlan).not.toHaveBeenCalled();
  });

  test('inside the window Week 2 is generated', async () => {
    const seeded = await seedPlan({ pending: false, planOverrides: { weekSchedule: dated(1) } });
    const res = await generateWeek(seeded, [2]);

    expect(res.status).toBe(200);
    expect(generateWeekPlan).toHaveBeenCalledTimes(1);
  });

  test('an old plan with no schedule and no flag is still allowed', async () => {
    const seeded = await seedPlan({ pending: false });
    const res = await generateWeek(seeded, [2]);

    expect(res.status).toBe(200);
  });
});

describe('creating a plan still builds the tier initial weeks', () => {
  test.each([
    ['Silver', [1, 2, 3, 4]],
    ['Golden', [1, 2]],
    ['Platinum', [1]],
  ])('%s asks the generator for %j', async (tier, expectedWeeks) => {
    const dietician = await createDietician();
    const patient = await createPatient();
    registerTestToken('dietician-token', dietician._id);
    const dietPlanRequest = await createDietPlanRequest(patient, dietician, {
      status: 'Unpaid',
      membershipPlan: `${tier} Membership`,
    });
    const firstConsultation = await FirstConsultation.create({ patient: patient._id, dietician: dietician._id });

    const res = await auth(request(app).post(`/api/dietician/patients/${patient._id}/diet-plans/generate`)).send({
      requestId: dietPlanRequest._id.toString(),
      firstConsultationId: firstConsultation._id.toString(),
      calorieStrategy: { calorieBudget: 2000 },
      macroStrategy: {},
    });

    expect(res.status).toBe(201);
    expect(generateWeekPlan).toHaveBeenCalledTimes(1);
    expect(generateWeekPlan.mock.calls[0][0].weekNumbers).toEqual(expectedWeeks);
  });
});
