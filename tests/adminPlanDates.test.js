/**
 * Plan dates builder (openspec admin-plan-dates-timeline). Pure function, no database.
 */
const { buildPlanDates, istDayKey } = require('../utils/adminPlanDates');
const { normalizePauses } = require('../utils/subscriptionPause');

const d = (s) => new Date(`${s}T00:00:00.000Z`);
const NOW = new Date('2026-10-20T06:00:00.000Z');

const week = (n, start, end) => ({ week: n, startDate: d(start), endDate: d(end) });
const pause = (start, resume, extra = {}) => ({ startDate: d(start), resumeDate: d(resume), ...extra });
const plan = (over = {}) => ({
  _id: 'plan1',
  request: 'req1',
  cycleNumber: 1,
  status: 'Active',
  activationDate: d('2026-10-04'),
  weekSchedule: [],
  pauses: [],
  ...over,
});
const request = (over = {}) => ({
  _id: 'req1',
  status: 'Completed',
  createdAt: d('2026-10-01'),
  subscriptionStartDate: d('2026-10-04'),
  subscriptionExpiresAt: new Date('2026-10-26T06:00:00.000Z'),
  ...over,
});

const build = (input) => buildPlanDates({ now: NOW, ...input });
const pausesOf = (result) => result.requests[0].cycles[0].pauses;

// This builder keeps its own istDayKey (design D2 says import utils/planEnd.js); the table pins the +05:30 offset.
describe('istDayKey', () => {
  it.each([
    ['2026-10-25T19:00:00.000Z', '2026-10-26'],
    ['2026-10-25T18:29:59.000Z', '2026-10-25'],
    ['2026-10-25T18:30:00.000Z', '2026-10-26'],
    [new Date('2026-10-25T06:00:00.000Z'), '2026-10-25'],
    [null, null],
    [undefined, null],
    ['', null],
    ['not a date', null],
    [new Date('invalid'), null],
  ])('reads %p as IST day %p', (input, expected) => {
    expect(istDayKey(input)).toBe(expected);
  });
});

describe('pause windows', () => {
  it('marks running, scheduled and ended windows against today', () => {
    const result = build({
      requests: [request()],
      plans: [
        plan({
          pauses: [pause('2026-10-05', '2026-10-08'), pause('2026-10-19', '2026-10-23'), pause('2026-10-28', '2026-10-30')],
        }),
      ],
    });
    expect(pausesOf(result).map((p) => p.state)).toEqual(['ended', 'running', 'scheduled']);
  });

  it('counts the start day as paused and the resume day as not paused', () => {
    const onStart = buildPlanDates({
      now: new Date('2026-10-19T23:00:00.000Z'),
      requests: [request()],
      plans: [plan({ pauses: [pause('2026-10-19', '2026-10-23')] })],
    });
    const onResume = buildPlanDates({
      now: new Date('2026-10-23T01:00:00.000Z'),
      requests: [request()],
      plans: [plan({ pauses: [pause('2026-10-19', '2026-10-23')] })],
    });
    expect(pausesOf(onStart)[0].state).toBe('running');
    expect(pausesOf(onResume)[0].state).toBe('ended');
  });

  it('gives day keys and the length in days', () => {
    const result = build({ requests: [request()], plans: [plan({ pauses: [pause('2026-10-19', '2026-10-24')] })] });
    expect(pausesOf(result)[0]).toMatchObject({ startDay: '2026-10-19', resumeDay: '2026-10-24', lengthDays: 5 });
  });

  it('reads a missing createdAt as recordedAt null and always sets setBy null', () => {
    const recorded = new Date('2026-10-18T09:30:00.000Z');
    const result = build({
      requests: [request()],
      plans: [plan({ pauses: [pause('2026-10-05', '2026-10-08'), pause('2026-10-19', '2026-10-23', { createdAt: recorded })] })],
    });
    const [old, recent] = pausesOf(result);
    expect(old.recordedAt).toBeNull();
    expect(recent.recordedAt).toBe(recorded.toISOString());
    expect(old.setBy).toBeNull();
    expect(recent.setBy).toBeNull();
  });

  it('skips a window whose resume is not after its start', () => {
    const result = build({
      requests: [request()],
      plans: [plan({ pauses: [pause('2026-10-19', '2026-10-19'), pause('2026-10-20', '2026-10-18')] })],
    });
    expect(pausesOf(result)).toEqual([]);
  });
});

describe('plan weeks', () => {
  const union = normalizePauses([pause('2026-10-14', '2026-10-19')]);

  it('shifts a week stored 11-18 Oct by a 5 day pause that starts before 18 Oct', () => {
    const result = build({
      requests: [request()],
      plans: [plan({ weekSchedule: [week(1, '2026-10-11', '2026-10-18')] })],
      unionPauses: union,
    });
    expect(result.requests[0].cycles[0].weeks[0]).toEqual({
      week: 1,
      storedStart: '2026-10-11',
      storedEnd: '2026-10-18',
      shownStart: '2026-10-11',
      shownEnd: '2026-10-23',
    });
    expect(result.requests[0].cycles[0].lastWeekEnd).toEqual({ stored: '2026-10-18', shown: '2026-10-23' });
    expect(result.appliedPauseDays).toBe(5);
  });

  it('gives an empty schedule weeks [] and no last week end', () => {
    const cycle = build({ requests: [request()], plans: [plan()] }).requests[0].cycles[0];
    expect(cycle.weeks).toEqual([]);
    expect(cycle.lastWeekEnd).toBeNull();
  });

  it('does not throw on a week with a missing date and gives it null fields', () => {
    const result = build({
      requests: [request()],
      plans: [plan({ weekSchedule: [{ week: 1, startDate: d('2026-10-11') }, week(2, '2026-10-18', '2026-10-25')] })],
      unionPauses: union,
    });
    const [broken, fine] = result.requests[0].cycles[0].weeks;
    expect(broken).toEqual({ week: 1, storedStart: '2026-10-11', storedEnd: null, shownStart: null, shownEnd: null });
    expect(fine.storedEnd).toBe('2026-10-25');
    expect(result.requests[0].cycles[0].lastWeekEnd).toEqual({ stored: '2026-10-25', shown: '2026-10-30' });
  });
});

describe('membership end and goals', () => {
  it('reads the stored expiry on its IST day: 25 Oct 19:00 UTC is 26 Oct', () => {
    const result = build({
      requests: [request({ subscriptionExpiresAt: new Date('2026-10-25T19:00:00.000Z') })],
    });
    expect(result.requests[0].expiresDay).toBe('2026-10-26');
    expect(result.requests[0].expiresAt).toBe('2026-10-25T19:00:00.000Z');
  });

  it('never shifts the stored end again and works out the end before pauses', () => {
    const pauses = [pause('2026-10-14', '2026-10-19')];
    const result = build({
      requests: [request()],
      plans: [plan({ pauses })],
      unionPauses: normalizePauses(pauses),
    });
    expect(result.requests[0].expiresDay).toBe('2026-10-26');
    expect(result.requests[0].pauseDaysIncluded).toBe(5);
    expect(result.requests[0].expiresBeforePausesDay).toBe('2026-10-21');
  });

  it('gives nulls when the request has no expiry', () => {
    const row = build({ requests: [request({ subscriptionExpiresAt: null })] }).requests[0];
    expect(row.expiresAt).toBeNull();
    expect(row.expiresDay).toBeNull();
    expect(row.expiresBeforePausesDay).toBeNull();
  });

  it('shifts a goal end stored 18 Oct by a finished 5 day pause', () => {
    const result = build({
      goals: [{ status: 'active', startDate: d('2026-10-04'), endDate: d('2026-10-18'), dietPlanId: 'plan1' }],
      unionPauses: normalizePauses([pause('2026-10-14', '2026-10-19')]),
    });
    expect(result.goals).toEqual([
      {
        status: 'active',
        storedStart: '2026-10-04',
        storedEnd: '2026-10-18',
        shownEnd: '2026-10-23',
        dietPlanId: 'plan1',
        seededFromCycle: null,
      },
    ]);
  });

  it('names the cycle of the plan a goal was seeded from, when that plan is loaded', () => {
    const result = build({
      requests: [request()],
      plans: [plan({ _id: 'plan1', cycleNumber: 2 })],
      goals: [
        { status: 'active', endDate: d('2026-10-18'), dietPlanId: 'plan1' },
        { status: 'completed', endDate: d('2026-10-04'), dietPlanId: 'gone' },
        { status: 'completed', endDate: d('2026-10-04') },
      ],
    });
    expect(result.goals.map((g) => g.seededFromCycle)).toEqual([2, null, null]);
  });

  it('gives goals [] when there is no goal', () => {
    expect(build({ requests: [request()] }).goals).toEqual([]);
  });

  it('returns no goal title, metric or target even when the rows carry them', () => {
    const result = build({
      requests: [request()],
      goals: [
        {
          status: 'active',
          endDate: d('2026-10-18'),
          title: 'Lose belly fat secret',
          metric: 'waist-circumference',
          targetValue: 64.25,
        },
      ],
    });
    const text = JSON.stringify(result);
    expect(text).not.toContain('Lose belly fat secret');
    expect(text).not.toContain('waist-circumference');
    expect(text).not.toContain('64.25');
  });
});

describe('grouping and summary', () => {
  const requests = [
    request({ _id: 'reqNew', createdAt: d('2026-10-10'), subscriptionExpiresAt: new Date('2026-12-20T06:00:00.000Z') }),
    request({ _id: 'reqOld' }),
  ];
  const plans = [
    plan({ _id: 'c3', request: 'reqNew', cycleNumber: 3, weekSchedule: [week(1, '2026-10-20', '2026-10-27')] }),
    plan({
      _id: 'c2',
      request: 'reqOld',
      cycleNumber: 2,
      weekSchedule: [week(1, '2026-10-18', '2026-10-25')],
    }),
    plan({
      _id: 'c1',
      request: 'reqOld',
      cycleNumber: 1,
      weekSchedule: [week(1, '2026-10-04', '2026-10-11')],
      pauses: [pause('2026-10-14', '2026-10-19')],
    }),
  ];
  const result = build({ requests, plans, unionPauses: normalizePauses([pause('2026-10-14', '2026-10-19')]) });

  it('groups by request newest first, with Latest only on the first', () => {
    expect(result.requests.map((r) => [r.requestId, r.isLatest])).toEqual([
      ['reqNew', true],
      ['reqOld', false],
    ]);
  });

  it('orders cycles by cycleNumber inside the request they link to', () => {
    expect(result.requests[0].cycles.map((c) => c.planId)).toEqual(['c3']);
    expect(result.requests[1].cycles.map((c) => c.planId)).toEqual(['c1', 'c2']);
  });

  it('lists a pause only under the cycle that stores it but shifts the weeks of other cycles by it', () => {
    expect(result.requests[1].cycles[0].pauses).toHaveLength(1);
    expect(result.requests[1].cycles[1].pauses).toEqual([]);
    expect(result.requests[0].cycles[0].pauses).toEqual([]);
    expect(result.requests[0].cycles[0].weeks[0]).toMatchObject({ storedEnd: '2026-10-27', shownEnd: '2026-11-01' });
    expect(result.requests[0].pauseDaysIncluded).toBe(0);
    expect(result.requests[1].pauseDaysIncluded).toBe(5);
  });

  it('lists a plan without a request under unlinkedCycles and counts its pauses in no request', () => {
    const withUnlinked = build({
      requests: [request()],
      plans: [plan({ request: null, _id: 'loose', pauses: [pause('2026-10-14', '2026-10-19')] })],
      unionPauses: normalizePauses([pause('2026-10-14', '2026-10-19')]),
    });
    expect(withUnlinked.unlinkedCycles.map((c) => c.planId)).toEqual(['loose']);
    expect(withUnlinked.requests[0].cycles).toEqual([]);
    expect(withUnlinked.requests[0].pauseDaysIncluded).toBe(0);
  });

  it('sets the summary from the latest request and the highest cycle with a schedule', () => {
    expect(result.summary).toMatchObject({
      requestId: 'reqNew',
      membershipEndDay: '2026-12-20',
      lastWeekEnd: { stored: '2026-10-27', shown: '2026-11-01', cycleNumber: 3 },
      goalEnd: null,
    });
  });

  it('gives a gap of 8 for the 18 Oct week and goal against a 26 Oct membership end, keeping stored dates', () => {
    const gap = build({
      requests: [request()],
      plans: [plan({ weekSchedule: [week(4, '2026-10-11', '2026-10-18')] })],
      goals: [{ status: 'active', endDate: d('2026-10-18') }],
    });
    expect(gap.summary.membershipEndDay).toBe('2026-10-26');
    expect(gap.summary.lastWeekEnd).toEqual({ stored: '2026-10-18', shown: '2026-10-18', cycleNumber: 1 });
    expect(gap.summary.goalEnd).toEqual({ stored: '2026-10-18', shown: '2026-10-18', status: 'active' });
    expect(gap.summary.gapDays).toEqual({ lastWeekShown: 8, goalShown: 8 });
  });

  it('gives a gap of 0 on the same day', () => {
    const same = build({
      requests: [request()],
      plans: [plan({ weekSchedule: [week(4, '2026-10-19', '2026-10-26')] })],
      goals: [{ status: 'active', endDate: d('2026-10-26') }],
    });
    expect(same.summary.gapDays).toEqual({ lastWeekShown: 0, goalShown: 0 });
  });

  it('leaves a gap null when either side is missing', () => {
    const missing = build({ requests: [request({ subscriptionExpiresAt: null })], goals: [{ status: 'active', endDate: d('2026-10-26') }] });
    expect(missing.summary.gapDays).toEqual({ lastWeekShown: null, goalShown: null });
  });

  it('uses only the active goal for the summary goal end', () => {
    const ended = build({ requests: [request()], goals: [{ status: 'completed', endDate: d('2026-10-18') }] });
    expect(ended.summary.goalEnd).toBeNull();
  });

  it('gives empty collections and a summary of nulls for a patient with nothing', () => {
    const empty = build({});
    expect(empty.requests).toEqual([]);
    expect(empty.unlinkedCycles).toEqual([]);
    expect(empty.summary).toEqual({
      requestId: null,
      membershipEndDay: null,
      lastWeekEnd: null,
      goalEnd: null,
      gapDays: { lastWeekShown: null, goalShown: null },
    });
  });
});

describe('extensions', () => {
  const entry = (over = {}) => ({
    outcome: 'success',
    createdAt: new Date('2026-10-10T08:00:00.000Z'),
    actorEmail: 'admin@example.com',
    before: { subscriptionExpiresAt: new Date('2026-10-12T06:00:00.000Z') },
    after: { subscriptionExpiresAt: new Date('2026-10-26T06:00:00.000Z') },
    reason: 'Missed two weeks',
    requestId: 'r-1',
    ...over,
  });
  const extensionsOf = (extensionEntries) => build({ extensionEntries, canViewAudit: true }).extensions;

  it('sends actor and reason as null unless the admin may view the audit log', () => {
    const [hidden] = build({ extensionEntries: [entry()] }).extensions;
    expect(hidden).toEqual({
      at: '2026-10-10T08:00:00.000Z',
      actorEmail: null,
      before: '2026-10-12',
      after: '2026-10-26',
      reason: null,
      applied: true,
      restricted: true,
    });
    expect(JSON.stringify(hidden)).not.toMatch(/admin@example\.com|Missed two weeks/);
  });

  it('lists one applied extension with before and after days', () => {
    expect(extensionsOf([entry()])).toEqual([
      {
        at: '2026-10-10T08:00:00.000Z',
        actorEmail: 'admin@example.com',
        before: '2026-10-12',
        after: '2026-10-26',
        reason: 'Missed two weeks',
        applied: true,
        restricted: false,
      },
    ]);
  });

  it('keeps an empty reason as an empty string, not restricted, for an admin who may view the audit log', () => {
    const [row] = extensionsOf([entry({ reason: undefined })]);
    expect(row.reason).toBe('');
    expect(row.restricted).toBe(false);
  });

  it('marks a success followed by a failed entry with the same request id as not applied', () => {
    const rows = extensionsOf([entry(), entry({ outcome: 'failed' })]);
    expect(rows).toHaveLength(1);
    expect(rows[0].applied).toBe(false);
  });

  it('keeps an extension applied when the failed entry has a different request id', () => {
    expect(extensionsOf([entry(), entry({ outcome: 'failed', requestId: 'r-2' })])[0].applied).toBe(true);
  });

  it('keeps entries without a request id applied even beside a failed entry', () => {
    const rows = extensionsOf([entry({ requestId: undefined }), entry({ outcome: 'failed', requestId: undefined })]);
    expect(rows).toHaveLength(1);
    expect(rows[0].applied).toBe(true);
  });

  it('cuts a 250 character reason to 200', () => {
    expect(extensionsOf([entry({ reason: 'x'.repeat(250) })])[0].reason).toHaveLength(200);
  });

  it('orders entries oldest first', () => {
    const rows = extensionsOf([
      entry({ createdAt: new Date('2026-10-12T08:00:00.000Z'), reason: 'second' }),
      entry({ createdAt: new Date('2026-10-10T08:00:00.000Z'), reason: 'first', requestId: 'r-2' }),
    ]);
    expect(rows.map((r) => r.reason)).toEqual(['first', 'second']);
  });

  it('gives [] for no entries', () => {
    expect(extensionsOf([])).toEqual([]);
  });

  it('returns nothing else from the audit row', () => {
    const [row] = extensionsOf([entry({ ip: '10.1.2.3', userAgent: 'Mozilla/9' })]);
    expect(Object.keys(row).sort()).toEqual(['actorEmail', 'after', 'applied', 'at', 'before', 'reason', 'restricted']);
    expect(JSON.stringify(row)).not.toMatch(/10\.1\.2\.3|Mozilla|r-1/);
  });
});
