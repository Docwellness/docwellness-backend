/**
 * Canonical week numbers for weekly checkpoints (utils/checkpointWeeks.js)
 * and the weeklyCheckpoints wrapper that old callers still use. Every date is
 * built with Date.UTC so the tests pass on any host timezone.
 */
const { connectTestDb, disconnectTestDb, clearTestDb } = require('./helpers/testDb');
const {
  buildCycles,
  buildCheckpointWeeks,
  displayWeekForLegacyEntry,
} = require('../utils/checkpointWeeks');

const utc = (m, d, y = 2026) => new Date(Date.UTC(y, m - 1, d));
const plan = (cycleNumber, start) => ({
  status: 'Active',
  cycleNumber,
  weekSchedule: [{ week: 1, startDate: start }],
});
// Weekly milestones sit on each week's last day: start + 6, 13, 20, ...
const weeklies = (start, count, titlePrefix = 'Week') =>
  Array.from({ length: count }, (_, i) => ({
    _id: `m-${start.getTime()}-${i}`,
    title: `${titlePrefix} ${i + 1}`,
    date: new Date(start.getTime() + (6 + 7 * i) * 86400000),
  }));

const cycle1Start = utc(9, 28);
const cycle2Start = utc(10, 26);
const twoCycles = [plan(1, cycle1Start), plan(2, cycle2Start)];
const weeks = (checkpoints) => checkpoints.map((c) => c.displayWeek);

describe('buildCheckpointWeeks', () => {
  test('cycle 1 checkpoints are weeks 1-4', async () => {
    const result = await buildCheckpointWeeks({
      plans: [plan(1, cycle1Start)],
      milestones: weeklies(cycle1Start, 4),
    });
    expect(weeks(result)).toEqual([1, 2, 3, 4]);
    expect(result.map((c) => c.cycleNumber)).toEqual([1, 1, 1, 1]);
    expect(result.map((c) => c.indexInCycle)).toEqual([1, 2, 3, 4]);
  });

  test('the first checkpoint of cycle 2 is week 5 and numbering continues', async () => {
    const result = await buildCheckpointWeeks({
      plans: twoCycles,
      milestones: [...weeklies(cycle1Start, 4), ...weeklies(cycle2Start, 4)],
    });
    expect(weeks(result)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(result[4].date).toEqual(utc(11, 1));
  });

  test('a stored "Week 6" title on the 1 Nov node is ignored: it is week 5', async () => {
    const stale = weeklies(cycle2Start, 1, 'Week');
    stale[0].title = 'Week 6';
    const result = await buildCheckpointWeeks({
      plans: twoCycles,
      milestones: [...weeklies(cycle1Start, 4), ...stale],
    });
    expect(result[4].displayWeek).toBe(5);
  });

  test('a missing cycle number keeps the Diet screen numbering: cycle 3 starts at 9', async () => {
    const cycle3Start = utc(11, 23);
    const result = await buildCheckpointWeeks({
      plans: [plan(1, cycle1Start), plan(3, cycle3Start)],
      milestones: [...weeklies(cycle1Start, 1), ...weeklies(cycle3Start, 1)],
    });
    expect(weeks(result)).toEqual([1, 9]);
  });

  test('milestones before the first plan start are excluded', async () => {
    const early = { _id: 'early', date: utc(9, 20) };
    const result = await buildCheckpointWeeks({
      plans: [plan(1, cycle1Start)],
      milestones: [early, ...weeklies(cycle1Start, 2)],
    });
    expect(result.map((c) => c.id)).not.toContain('early');
    expect(weeks(result)).toEqual([1, 2]);
  });

  test('draft plans do not make a cycle', () => {
    expect(buildCycles([{ ...plan(1, cycle1Start), status: 'Draft' }])).toEqual([]);
  });
});

describe('displayWeekForLegacyEntry', () => {
  const cycles = buildCycles(twoCycles);

  test('week 1 dated in cycle 1 stays week 1', () => {
    expect(displayWeekForLegacyEntry({ week: 1, date: utc(10, 4) }, cycles)).toBe(1);
  });

  test('week 1 dated in cycle 2 is week 5, week 2 in cycle 2 is week 6', () => {
    expect(displayWeekForLegacyEntry({ week: 1, date: utc(11, 1) }, cycles)).toBe(5);
    expect(displayWeekForLegacyEntry({ week: 2, date: utc(11, 8) }, cycles)).toBe(6);
  });

  test('an entry dated before every plan start counts as cycle 1', () => {
    expect(displayWeekForLegacyEntry({ week: 2, date: utc(9, 1) }, cycles)).toBe(2);
  });

  test('an entry tagged weekBasis display already holds the canonical week', () => {
    expect(
      displayWeekForLegacyEntry({ week: 5, weekBasis: 'display', date: utc(11, 1) }, cycles)
    ).toBe(5);
  });

  test('an untagged entry has no week', () => {
    expect(displayWeekForLegacyEntry({ week: null, date: utc(11, 1) }, cycles)).toBeNull();
  });
});

describe('weeklyCheckpoints wrapper', () => {
  let Goal, Milestone, DietPlan, weeklyCheckpoints;

  beforeAll(async () => {
    await connectTestDb();
    ({ Goal, Milestone, DietPlan } = require('../models'));
    ({ weeklyCheckpoints } = require('../utils/weeklyCheckpoints'));
  });
  afterEach(async () => clearTestDb());
  afterAll(async () => disconnectTestDb());

  test('keeps the { id, date, weekNumber } shape and returns the display week', async () => {
    const { createPatient, createDietician } = require('./helpers/factories');
    const patient = await createPatient();
    const dietician = await createDietician();
    for (const [n, start] of [[1, cycle1Start], [2, cycle2Start]]) {
      await DietPlan.create({
        patientId: patient._id,
        dieticianId: dietician._id,
        status: n === 1 ? 'Completed' : 'Active',
        cycleNumber: n,
        weekSchedule: [{ week: 1, startDate: start, endDate: start }],
      });
    }
    const goal = await Goal.create({
      patientId: patient._id,
      dieticianId: dietician._id,
      title: 'g',
      startValue: 75,
      targetValue: 60,
      startDate: cycle1Start,
      endDate: utc(11, 22),
      status: 'active',
    });
    await Milestone.insertMany(
      [...weeklies(cycle1Start, 4), ...weeklies(cycle2Start, 4)].map((m) => ({
        goalId: goal._id,
        type: 'weekly',
        title: m.title,
        date: m.date,
        sortOrder: 900,
      }))
    );

    const all = await weeklyCheckpoints(goal._id, null);
    expect(all.map((c) => c.weekNumber)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(Object.keys(all[0]).sort()).toEqual(['date', 'id', 'weekNumber']);

    const fromCycle2 = await weeklyCheckpoints(goal._id, cycle2Start);
    expect(fromCycle2.map((c) => c.weekNumber)).toEqual([5, 6, 7, 8]);
  });
});
