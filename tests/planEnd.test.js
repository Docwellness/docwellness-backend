const { connectTestDb, disconnectTestDb, clearTestDb } = require('./helpers/testDb');

let planEnd, Goal, Milestone, createPatient, createDietician, createDietPlanRequest, createActiveDietPlan;

beforeAll(async () => {
  await connectTestDb();
  planEnd = require('../utils/planEnd');
  ({ Goal, Milestone } = require('../models'));
  ({ createPatient, createDietician, createDietPlanRequest, createActiveDietPlan } = require('./helpers/factories'));
});
afterEach(async () => clearTestDb());
afterAll(async () => disconnectTestDb());

const D = (s) => new Date(`${s}T00:00:00.000Z`);

describe('endDayOf / istDayKey', () => {
  test('an expiry on 18 Oct 17:00 UTC (22:30 IST) ends on 18 Oct', () => {
    expect(planEnd.endDayOf(new Date('2026-10-18T17:00:00.000Z'))).toBe('2026-10-18');
  });

  test('an expiry on 18 Oct 19:00 UTC (00:30 IST) ends on 19 Oct', () => {
    expect(planEnd.endDayOf(new Date('2026-10-18T19:00:00.000Z'))).toBe('2026-10-19');
  });

  test('no expiry means no end day', () => {
    expect(planEnd.endDayOf(null)).toBeNull();
    expect(planEnd.endDayOf(undefined)).toBeNull();
    expect(planEnd.endDayOf('not a date')).toBeNull();
  });
});

describe('computeLastWeighInDate', () => {
  const lastWeighIn = (args) => planEnd.computeLastWeighInDate({ pauses: [], ...args });

  test('a milestone the day after the end day is the last weigh-in', () => {
    expect(lastWeighIn({ endDay: '2026-10-18', weeklyMilestoneDates: [D('2026-10-19')] })).toBe('2026-10-19');
  });

  test('a milestone on the end day does not close the window: the next one counts', () => {
    expect(
      lastWeighIn({ endDay: '2026-10-18', weeklyMilestoneDates: [D('2026-10-18'), D('2026-10-25')] })
    ).toBe('2026-10-25');
  });

  test('only milestones on or before the end day falls back to end day + 1', () => {
    expect(
      lastWeighIn({ endDay: '2026-10-18', weeklyMilestoneDates: [D('2026-10-11'), D('2026-10-18')] })
    ).toBe('2026-10-19');
  });

  test('no milestone falls back to end day + 1', () => {
    expect(lastWeighIn({ endDay: '2026-10-18', weeklyMilestoneDates: [] })).toBe('2026-10-19');
  });

  test('an admin-extended expiry with unshifted milestones takes the first one after it', () => {
    expect(
      lastWeighIn({
        endDay: '2026-10-22',
        weeklyMilestoneDates: [D('2026-10-18'), D('2026-10-25'), D('2026-11-01')],
      })
    ).toBe('2026-10-25');
  });

  test('a pause window shifts a milestone from 19 Oct to 24 Oct', () => {
    const pauses = [{ startDate: D('2026-10-10'), resumeDate: D('2026-10-15') }];
    expect(
      lastWeighIn({ endDay: '2026-10-23', weeklyMilestoneDates: [D('2026-10-19')], pauses })
    ).toBe('2026-10-24');
  });

  test('an unsorted milestone list still yields the earliest one after the end day', () => {
    expect(
      lastWeighIn({
        endDay: '2026-10-18',
        weeklyMilestoneDates: [D('2026-11-01'), D('2026-10-25'), D('2026-10-04')],
      })
    ).toBe('2026-10-25');
  });

  test('no end day gives no date', () => {
    expect(lastWeighIn({ endDay: null, weeklyMilestoneDates: [D('2026-10-19')] })).toBeNull();
  });
});

describe('closed checks', () => {
  const ended = { endDay: '2026-10-18', lastWeighInDate: '2026-10-19' };

  test('non-weight logging is closed only after the end day', () => {
    expect(planEnd.isNonWeightLogClosed(ended, '2026-10-18')).toBe(false);
    expect(planEnd.isNonWeightLogClosed(ended, '2026-10-19')).toBe(true);
    expect(planEnd.isNonWeightLogClosed({ endDay: null }, '2030-01-01')).toBe(false);
  });

  test('weight logging is closed only after the last weigh-in date', () => {
    expect(planEnd.isWeightClosed(ended, '2026-10-19')).toBe(false);
    expect(planEnd.isWeightClosed(ended, '2026-10-20')).toBe(true);
    expect(planEnd.isWeightClosed({ endDay: null, lastWeighInDate: null }, '2030-01-01')).toBe(false);
  });
});

describe('loadPlanEnd', () => {
  const now = new Date('2026-10-20T06:00:00.000Z');

  async function setup(requestOverrides) {
    const dietician = await createDietician();
    const patient = await createPatient();
    const request = requestOverrides
      ? await createDietPlanRequest(patient, dietician, requestOverrides)
      : null;
    return { dietician, patient, request };
  }

  async function addWeeklyMilestone(patient, dietician, date) {
    const goal =
      (await Goal.findOne({ patientId: patient._id })) ||
      (await Goal.create({
        patientId: patient._id,
        dieticianId: dietician._id,
        title: 'Lose weight',
        startValue: 70,
        targetValue: 65,
        startDate: D('2026-09-18'),
        endDate: D('2026-10-18'),
      }));
    await Milestone.create({ goalId: goal._id, type: 'weekly', title: 'Weigh-in', date, sortOrder: 1 });
  }

  test('no request gives nulls', async () => {
    const { patient } = await setup();
    const result = await planEnd.loadPlanEnd(patient._id, now);
    expect(result.endDay).toBeNull();
    expect(result.lastWeighInDate).toBeNull();
  });

  test('a request without an expiry gives nulls and reports the request', async () => {
    const { patient, request } = await setup({ hasActivePlan: true });
    const result = await planEnd.loadPlanEnd(patient._id, now);
    expect(result.endDay).toBeNull();
    expect(result.lastWeighInDate).toBeNull();
    expect(String(result.requestId)).toBe(String(request._id));
    expect(result.hasActivePlan).toBe(true);
  });

  test('a future expiry sets the end day only', async () => {
    const { patient } = await setup({ subscriptionExpiresAt: new Date('2026-10-25T10:00:00.000Z') });
    const result = await planEnd.loadPlanEnd(patient._id, now);
    expect(result.endDay).toBe('2026-10-25');
    expect(result.lastWeighInDate).toBeNull();
  });

  test('an expired plan with a weekly milestone after the end gives its date', async () => {
    const { patient, dietician } = await setup({ subscriptionExpiresAt: new Date('2026-10-18T10:00:00.000Z') });
    await addWeeklyMilestone(patient, dietician, D('2026-10-19'));
    const result = await planEnd.loadPlanEnd(patient._id, now);
    expect(result.endDay).toBe('2026-10-18');
    expect(result.lastWeighInDate).toBe('2026-10-19');
  });

  test('an expired plan with no goal falls back to end day + 1', async () => {
    const { patient } = await setup({ subscriptionExpiresAt: new Date('2026-10-18T10:00:00.000Z') });
    const result = await planEnd.loadPlanEnd(patient._id, now);
    expect(result.lastWeighInDate).toBe('2026-10-19');
  });

  test.each([
    ['Paid', { status: 'Paid', hasActivePlan: true }],
    ['Unpaid with a plan', { status: 'Unpaid', hasActivePlan: true }],
    ['PaymentSubmitted', { status: 'PaymentSubmitted', hasActivePlan: true }],
  ])('a %s request gives the same end day', async (_label, overrides) => {
    const { patient } = await setup({
      ...overrides,
      subscriptionExpiresAt: new Date('2026-10-18T10:00:00.000Z'),
    });
    const result = await planEnd.loadPlanEnd(patient._id, now);
    expect(result.endDay).toBe('2026-10-18');
  });

  test('only the latest request counts', async () => {
    const { patient, dietician } = await setup({ subscriptionExpiresAt: new Date('2026-10-01T10:00:00.000Z') });
    await createDietPlanRequest(patient, dietician, {
      subscriptionExpiresAt: new Date('2026-11-18T10:00:00.000Z'),
      createdAt: new Date(Date.now() + 1000),
    });
    const result = await planEnd.loadPlanEnd(patient._id, now);
    expect(result.endDay).toBe('2026-11-18');
  });
});

describe('loadPlanEnd follows the last plan week, not the membership expiry', () => {
  const week = (n, start, end) => ({ week: n, startDate: D(start), endDate: D(end) });
  const weeks = [
    week(1, '2026-09-21', '2026-09-27'),
    week(2, '2026-09-28', '2026-10-04'),
    week(3, '2026-10-05', '2026-10-11'),
    week(4, '2026-10-12', '2026-10-18'),
  ];

  async function setup(planOverrides = {}) {
    const dietician = await createDietician();
    const patient = await createPatient();
    await createDietPlanRequest(patient, dietician, {
      status: 'Paid',
      hasActivePlan: true,
      subscriptionExpiresAt: new Date('2026-10-26T06:28:32.726Z'),
    });
    await createActiveDietPlan(patient, dietician, { weekSchedule: weeks, ...planOverrides });
    return patient;
  }

  test('ends on 18 Oct although the membership runs to 26 Oct', async () => {
    const patient = await setup();
    const result = await planEnd.loadPlanEnd(patient._id, new Date('2026-10-25T06:00:00.000Z'));
    expect(result.endDay).toBe('2026-10-18');
    expect(result.lastWeighInDate).toBe('2026-10-19');
  });

  test('a pause shifts the last week end', () => {
    const pauses = [{ startDate: D('2026-10-05'), resumeDate: D('2026-10-08') }];
    expect(planEnd.lastWeekEndDayOf(weeks, pauses)).toBe('2026-10-21');
  });

  test('no week schedule falls back to the membership expiry', async () => {
    const patient = await setup({ weekSchedule: [] });
    const result = await planEnd.loadPlanEnd(patient._id, new Date('2026-10-20T06:00:00.000Z'));
    expect(result.endDay).toBe('2026-10-26');
  });

  test('lastWeekEndDayOf ignores undated weeks', () => {
    expect(planEnd.lastWeekEndDayOf([{ week: 1 }], [])).toBeNull();
    expect(planEnd.lastWeekEndDayOf(undefined, [])).toBeNull();
  });
});

