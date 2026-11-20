/**
 * Payment approval dates a plan that was created without dates
 * (startDatePending): the start-date options endpoint, the picked day
 * validated before anything is written, the dates derived from it, the
 * exercise plan following a first-time start, and the old flow left alone.
 * Days are relative to today (IST) so the tests do not depend on the calendar.
 */
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
let ManualPaymentProof;
let ExercisePlan;
let Notification;
let planEnd;
let addDaysToDay;
let buildWeekSchedule;

beforeAll(async () => {
  await connectTestDb();
  request = require('supertest');
  app = require('../config/createApp')();
  ({ createPatient, createDietician, createDietPlanRequest, createActiveDietPlan } = require('./helpers/factories'));
  ({ DietPlan, DietPlanRequest, ManualPaymentProof, ExercisePlan, Notification } = require('../models'));
  planEnd = require('../utils/planEnd');
  ({ addDaysToDay } = require('../utils/planStartDate'));
  ({ buildWeekSchedule } = require('../utils/weekSchedule'));
});

afterEach(async () => {
  jest.restoreAllMocks();
  clearTestTokens();
  await clearTestDb();
});

afterAll(async () => {
  await disconnectTestDb();
});

const auth = (req) => req.set('Authorization', 'Bearer dietician-token');
const today = () => planEnd.istDayKey(new Date());
const day = (offset) => addDaysToDay(today(), offset);
const dayKey = (date) => date.toISOString().slice(0, 10);
const planUrl = (patient, plan, suffix) => `/api/dietician/patients/${patient._id}/diet-plans/${plan._id}/${suffix}`;

/** A Finalized plan waiting for its payment approval, with a Submitted proof. */
async function seedPending({ pending = true, amountPending = 0, runningEndsInDays = null, requestOverrides = {} } = {}) {
  const dietician = await createDietician();
  const patient = await createPatient();
  registerTestToken('dietician-token', dietician._id);
  const dietPlanRequest = await createDietPlanRequest(patient, dietician, {
    status: 'PaymentSubmitted',
    startDateForDiet: new Date(`${day(-3)}T00:00:00.000Z`),
    ...requestOverrides,
  });
  if (runningEndsInDays !== null) {
    await createActiveDietPlan(patient, dietician, {
      request: dietPlanRequest._id,
      cycleNumber: 1,
      weekSchedule: buildWeekSchedule(new Date(`${day(runningEndsInDays - 27)}T00:00:00.000Z`)),
    });
  }
  const plan = await DietPlan.create({
    patientId: patient._id,
    dieticianId: dietician._id,
    request: dietPlanRequest._id,
    status: 'Finalized',
    cycleNumber: runningEndsInDays === null ? 1 : 2,
    startDatePending: pending,
  });
  const proof = await ManualPaymentProof.create({
    request: dietPlanRequest._id,
    patient: patient._id,
    amountReceived: 5000,
    amountPending,
    status: 'Submitted',
  });
  await DietPlanRequest.updateOne({ _id: dietPlanRequest._id }, { latestPaymentProof: proof._id });
  return { dietician, patient, dietPlanRequest, plan, proof };
}

const activate = ({ patient, plan }, body) => auth(request(app).post(planUrl(patient, plan, 'activate'))).send(body);

describe('GET start-date-options', () => {
  const options = ({ patient, plan }) => auth(request(app).get(planUrl(patient, plan, 'start-date-options')));

  test('a first-time plan defaults to today and cannot start earlier', async () => {
    const res = await options(await seedPending());

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      required: true,
      defaultDate: today(),
      minDate: today(),
      isRenewal: false,
      runningCycleEndDate: null,
    });
  });

  test('a renewal may start the day after the running plan ends', async () => {
    const res = await options(await seedPending({ runningEndsInDays: 10 }));

    expect(res.body.data).toEqual({
      required: true,
      defaultDate: today(),
      minDate: day(11),
      isRenewal: true,
      runningCycleEndDate: day(10),
    });
  });

  test('a plan created with its dates up front does not ask for one', async () => {
    const res = await options(await seedPending({ pending: false }));

    expect(res.status).toBe(200);
    expect(res.body.data.required).toBe(false);
  });

  test('another dietician gets 404 like activate does', async () => {
    const seeded = await seedPending();
    const other = await createDietician();
    registerTestToken('dietician-token', other._id);

    expect((await options(seeded)).status).toBe(404);
  });

  test('a malformed plan id gets 400', async () => {
    const { patient } = await seedPending();
    const res = await auth(
      request(app).get(`/api/dietician/patients/${patient._id}/diet-plans/not-an-id/start-date-options`)
    );

    expect(res.status).toBe(400);
  });
});

describe('POST activate on a pending plan', () => {
  test('a late payment starts today, with week 4 ending 27 days on and the plan ending with it', async () => {
    const seeded = await seedPending();
    const res = await activate(seeded, { startDate: today() });

    expect(res.status).toBe(200);
    const plan = await DietPlan.findById(seeded.plan._id);
    expect(plan.status).toBe('Active');
    expect(plan.startDatePending).toBe(false);
    expect(dayKey(plan.startDate)).toBe(today());
    expect(plan.weekSchedule.map((w) => [dayKey(w.startDate), dayKey(w.endDate)])).toEqual([
      [today(), day(6)],
      [day(7), day(13)],
      [day(14), day(20)],
      [day(21), day(27)],
    ]);

    const saved = await DietPlanRequest.findById(seeded.dietPlanRequest._id);
    expect(dayKey(saved.startDateForDiet)).toBe(today());
    expect(dayKey(saved.subscriptionStartDate)).toBe(today());
    expect(planEnd.istDayKey(saved.subscriptionExpiresAt)).toBe(day(30));
    expect(saved.renewalReminderSentAt).toBeNull();

    expect((await planEnd.loadPlanEnd(seeded.patient._id)).endDay).toBe(day(27));
  });

  test('a future pick starts the plan, the request and the subscription on that day', async () => {
    const seeded = await seedPending();
    const res = await activate(seeded, { startDate: day(6) });

    expect(res.status).toBe(200);
    const plan = await DietPlan.findById(seeded.plan._id);
    expect(dayKey(plan.weekSchedule[0].startDate)).toBe(day(6));
    const saved = await DietPlanRequest.findById(seeded.dietPlanRequest._id);
    expect(dayKey(saved.subscriptionStartDate)).toBe(day(6));
    expect(planEnd.istDayKey(saved.subscriptionExpiresAt)).toBe(day(36));
  });

  test('a past date is refused and every document is left as it was', async () => {
    const seeded = await seedPending();
    const res = await activate(seeded, { startDate: day(-1) });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('START_DATE_INVALID');
    expect((await ManualPaymentProof.findById(seeded.proof._id)).status).toBe('Submitted');
    expect((await DietPlanRequest.findById(seeded.dietPlanRequest._id)).status).toBe('PaymentSubmitted');
    const plan = await DietPlan.findById(seeded.plan._id);
    expect(plan.status).toBe('Finalized');
    expect(plan.startDatePending).toBe(true);
    expect(plan.weekSchedule).toHaveLength(0);
  });

  test('a missing date is refused with START_DATE_REQUIRED and changes nothing', async () => {
    const seeded = await seedPending();
    const res = await activate(seeded, {});

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('START_DATE_REQUIRED');
    expect((await ManualPaymentProof.findById(seeded.proof._id)).status).toBe('Submitted');
    expect((await DietPlan.findById(seeded.plan._id)).status).toBe('Finalized');
  });

  test.each(['2026-02-30', '19-11-2026', '2026-11-19T00:00:00.000Z', 'tomorrow'])(
    'the malformed date %s is refused with START_DATE_INVALID and changes nothing',
    async (startDate) => {
      const seeded = await seedPending();
      const res = await activate(seeded, { startDate });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('START_DATE_INVALID');
      expect((await ManualPaymentProof.findById(seeded.proof._id)).status).toBe('Submitted');
      expect((await DietPlan.findById(seeded.plan._id)).status).toBe('Finalized');
    }
  );

  describe('when the earliest day moves after the first validation', () => {
    // Returns a query continuation that, once, creates a running plan ending on
    // day(10) and passes the query result through, so the earliest allowed start
    // jumps to day(11) after the first bounds check passed.
    const startRunningPlanOnce = ({ patient, dietician, dietPlanRequest }) => {
      let started = false;
      return async (result) => {
        if (!started) {
          started = true;
          await createActiveDietPlan(patient, dietician, {
            request: dietPlanRequest._id,
            cycleNumber: 1,
            weekSchedule: buildWeekSchedule(new Date(`${day(-17)}T00:00:00.000Z`)),
          });
        }
        return result;
      };
    };

    test('a start day that becomes too early before the first write is refused with the proof still Submitted', async () => {
      const seeded = await seedPending();
      const originalFindOne = ManualPaymentProof.findOne.bind(ManualPaymentProof);
      const startRunningPlan = startRunningPlanOnce(seeded);
      jest.spyOn(ManualPaymentProof, 'findOne').mockImplementation((...args) => originalFindOne(...args).then(startRunningPlan));

      const res = await activate(seeded, { startDate: today() });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('START_DATE_INVALID');
      const proof = await ManualPaymentProof.findById(seeded.proof._id);
      expect(proof.status).toBe('Submitted');
      expect(proof.amountReceived).toBe(5000);
      expect((await DietPlanRequest.findById(seeded.dietPlanRequest._id)).status).toBe('PaymentSubmitted');
      const plan = await DietPlan.findById(seeded.plan._id);
      expect(plan.status).toBe('Finalized');
      expect(plan.startDatePending).toBe(true);
      expect(plan.weekSchedule).toHaveLength(0);
      expect((await DietPlanRequest.findById(seeded.dietPlanRequest._id)).subscriptionStartDate).toBeFalsy();
    });

    test('the same move on a request with no proof is refused and the request is not written', async () => {
      const seeded = await seedPending({ requestOverrides: { status: 'Unpaid' } });
      await DietPlanRequest.updateOne({ _id: seeded.dietPlanRequest._id }, { $unset: { latestPaymentProof: 1 } });
      const originalExists = DietPlan.exists.bind(DietPlan);
      const startRunningPlan = startRunningPlanOnce(seeded);
      // The first "is there another Active plan" lookup is the bounds check.
      let boundsChecks = 0;
      jest.spyOn(DietPlan, 'exists').mockImplementation((filter, ...rest) => {
        const query = originalExists(filter, ...rest);
        const isBoundsLookup = filter?.status === 'Active' && filter._id?.$ne;
        if (!isBoundsLookup || ++boundsChecks > 1) return query;
        return query.then(startRunningPlan);
      });

      const res = await activate(seeded, { startDate: today() });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('START_DATE_INVALID');
      const saved = await DietPlanRequest.findById(seeded.dietPlanRequest._id);
      expect(saved.status).toBe('Unpaid');
      expect(saved.subscriptionStartDate).toBeFalsy();
      expect((await DietPlan.findById(seeded.plan._id)).startDatePending).toBe(true);
    });
  });

  test('a renewal cannot overlap the running plan', async () => {
    const seeded = await seedPending({ runningEndsInDays: 10 });
    const res = await activate(seeded, { startDate: day(10) });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('START_DATE_INVALID');
    expect((await ManualPaymentProof.findById(seeded.proof._id)).status).toBe('Submitted');
    expect((await DietPlan.findById(seeded.plan._id)).status).toBe('Finalized');
  });

  test('a renewal may start on the earliest allowed day', async () => {
    const seeded = await seedPending({ runningEndsInDays: 10 });
    const res = await activate(seeded, { startDate: day(11) });

    expect(res.status).toBe(200);
    expect(dayKey((await DietPlan.findById(seeded.plan._id)).startDate)).toBe(day(11));
  });

  test('the request is Paid when nothing is pending and PartiallyPaid when a balance remains', async () => {
    const paid = await seedPending();
    await activate(paid, { startDate: today() });
    expect((await DietPlanRequest.findById(paid.dietPlanRequest._id)).status).toBe('Paid');
    expect((await ManualPaymentProof.findById(paid.proof._id)).status).toBe('Approved');

    const partial = await seedPending({ amountPending: 2000 });
    await activate(partial, { startDate: today() });
    expect((await DietPlanRequest.findById(partial.dietPlanRequest._id)).status).toBe('PartiallyPaid');
  });

  test('an already active plan is still refused', async () => {
    const seeded = await seedPending();
    await DietPlan.updateOne({ _id: seeded.plan._id }, { status: 'Active' });
    const res = await activate(seeded, { startDate: today() });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/already active/i);
  });

  test('exactly one notification is sent, the existing diet plan ready one, with no date in it', async () => {
    const seeded = await seedPending();
    await activate(seeded, { startDate: day(6) });
    await new Promise((resolve) => setTimeout(resolve, 200)); // the notification is written without being awaited

    const notifications = await Notification.find({ userId: seeded.patient._id }).lean();
    expect(notifications).toHaveLength(1);
    expect(notifications[0].data.ruleKey).toBe('diet_plan_ready');
    expect(notifications[0].message).not.toMatch(/\d/);
  });
});

describe('POST activate on a plan created with its dates (old flow)', () => {
  test('activates as before: no date asked for, a startDate in the body is ignored', async () => {
    const seeded = await seedPending({ pending: false });
    const res = await activate(seeded, { startDate: day(6) });

    expect(res.status).toBe(200);
    const plan = await DietPlan.findById(seeded.plan._id);
    expect(plan.status).toBe('Active');
    expect(plan.startDate).toBeUndefined();
    expect(plan.weekSchedule).toHaveLength(0);
    expect(dayKey((await DietPlanRequest.findById(seeded.dietPlanRequest._id)).startDateForDiet)).toBe(day(-3));
  });
});

describe('POST activate moves the exercise plan for a first-time plan only', () => {
  const exercise = (seeded, overrides = {}) =>
    ExercisePlan.create({
      patientId: seeded.patient._id,
      dieticianId: seeded.dietician._id,
      startDate: new Date('2020-01-01T00:00:00.000Z'),
      ...overrides,
    });
  const startOf = async (plan) => dayKey((await ExercisePlan.findById(plan._id)).startDate);

  test('a first-time approval moves a Draft and an Active exercise plan', async () => {
    const seeded = await seedPending();
    const drafted = await exercise(seeded, { status: 'Draft' });
    const res = await activate(seeded, { startDate: day(6) });
    expect(res.status).toBe(200);
    expect(await startOf(drafted)).toBe(day(6));

    const other = await seedPending();
    const running = await exercise(other, { status: 'Active' });
    await activate(other, { startDate: day(6) });
    expect(await startOf(running)).toBe(day(6));
  });

  test('a renewal leaves the running exercise plan alone', async () => {
    const seeded = await seedPending({ runningEndsInDays: 10 });
    const running = await exercise(seeded, { status: 'Active' });
    const res = await activate(seeded, { startDate: day(11) });

    expect(res.status).toBe(200);
    expect(await startOf(running)).toBe('2020-01-01');
  });

  test('a patient with no exercise plan is approved and none is created', async () => {
    const seeded = await seedPending();
    const res = await activate(seeded, { startDate: today() });

    expect(res.status).toBe(200);
    expect(await ExercisePlan.countDocuments({ patientId: seeded.patient._id })).toBe(0);
  });

  test('a Completed-only exercise plan is untouched', async () => {
    const seeded = await seedPending();
    const completed = await exercise(seeded, { status: 'Completed' });
    await activate(seeded, { startDate: day(6) });

    expect(await startOf(completed)).toBe('2020-01-01');
  });

  test('with a Completed and a Draft plan only the Draft moves', async () => {
    const seeded = await seedPending();
    const completed = await exercise(seeded, { status: 'Completed' });
    const drafted = await exercise(seeded, { status: 'Draft' });
    await activate(seeded, { startDate: day(6) });

    expect(await startOf(completed)).toBe('2020-01-01');
    expect(await startOf(drafted)).toBe(day(6));
  });

  test('a failure looking the exercise plan up still approves the plan', async () => {
    const seeded = await seedPending();
    jest.spyOn(ExercisePlan, 'findOne').mockImplementation(() => ({
      sort: () => Promise.reject(new Error('lookup failed')),
    }));
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const res = await activate(seeded, { startDate: today() });

    expect(res.status).toBe(200);
    expect((await DietPlan.findById(seeded.plan._id)).status).toBe('Active');
  });
});
