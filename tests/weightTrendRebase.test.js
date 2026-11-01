/**
 * The planned weight line re-bases at each weekly-checkpoint weigh-in
 * (utils/weightTrendRebase.js). Pure: no database. Every date is built with
 * Date.UTC so the tests pass on any host timezone.
 */
const { buildRebasedWeightTrend } = require('../utils/weightTrendRebase');
const { buildDateBuckets } = require('../utils/trackingBuckets');

const utc = (m, d, y = 2026) => new Date(Date.UTC(y, m - 1, d));
const endOfDay = (date) => new Date(date.getTime() + 24 * 60 * 60 * 1000 - 1);

// Goal: 75 -> 60 kg, first plan start 28 Sep, goal end 21 Dec (84 days).
const HISTORY_START = utc(9, 28);
const GOAL_END = utc(12, 21);
const TODAY = utc(12, 31);
const NOW = new Date(Date.UTC(2026, 11, 31, 12));

const checkpoint = (week, weight, date, { enteredOn = date } = {}) => ({
  date: enteredOn,
  weight,
  displayWeek: week,
  checkpointDate: date,
});

function trend(weighIns, overrides = {}) {
  const { from = utc(10, 25), to = utc(11, 3), ...rest } = overrides;
  const { buckets } = buildDateBuckets(from, endOfDay(to));
  return buildRebasedWeightTrend({
    buckets,
    today: TODAY,
    now: NOW,
    currentWeight: 64,
    goalStartWeight: 75,
    goalTargetWeight: 60,
    goalEnd: GOAL_END,
    historyStart: HISTORY_START,
    weighIns,
    ...rest,
  });
}

const on = (points, key) => points.find((p) => p.date === key);

describe('buildRebasedWeightTrend', () => {
  const week4 = checkpoint(4, 64, utc(10, 25));

  test('Week 5 starts at the Week 4 actual weight and reaches the target on the goal end', () => {
    const points = trend([week4]);
    expect(on(points, '2026-10-25').weight).toBe(64);
    // 9 of 57 days from 25 Oct to 21 Dec: 64 - 4 * 9 / 57
    expect(on(points, '2026-11-03').weight).toBe(63.4);

    const atEnd = trend([week4], { from: GOAL_END, to: GOAL_END });
    expect(atEnd[0].weight).toBe(60);
  });

  test('a day after the goal end shows the target', () => {
    const points = trend([week4], { from: utc(12, 22), to: utc(12, 22) });
    expect(points[0].weight).toBe(60);
  });

  test('a new Week 5 log re-bases from that day and earlier values are unchanged', () => {
    const before = trend([week4]);
    const week5 = checkpoint(5, 62, utc(11, 1), { enteredOn: utc(11, 3) });
    const after = trend([week4, week5]);

    expect(on(after, '2026-11-01').weight).toBe(62);
    // 2 of 55 days from 1 Nov to 21 Dec: 62 - 2 * 2 / 55
    expect(on(after, '2026-11-03').weight).toBe(61.9);
    for (const point of before.filter((p) => p.date < '2026-11-01')) {
      expect(on(after, point.date).weight).toBe(point.weight);
    }
  });

  test('without a checkpoint weigh-in the line runs from the goal start weight', () => {
    const first = trend([], { from: HISTORY_START, to: HISTORY_START });
    expect(first[0].weight).toBe(75);
    // 42 of 84 days from 28 Sep
    const mid = trend([], { from: utc(11, 9), to: utc(11, 9) });
    expect(mid[0].weight).toBe(67.5);
  });

  test('a weight-gain goal rises from the checkpoint weigh-in', () => {
    const gain = {
      goalStartWeight: 58,
      goalTargetWeight: 68,
      currentWeight: 59,
    };
    const points = trend([checkpoint(1, 59, utc(10, 4))], { ...gain, from: utc(10, 4), to: utc(10, 10) });
    expect(points[0].weight).toBe(59);
    expect(points[6].weight).toBeGreaterThan(points[0].weight);
  });

  test('a missing Week 4 keeps the Week 3 anchor', () => {
    const week3 = checkpoint(3, 66, utc(10, 18));
    const points = trend([week3], { from: utc(10, 25), to: utc(10, 25) });
    // 7 of 64 days from 18 Oct to 21 Dec: 66 - 6 * 7 / 64
    expect(points[0].weight).toBe(65.3);
  });

  test('an untagged weigh-in is a measured point but does not re-base', () => {
    const untagged = { date: utc(10, 25), weight: 64, displayWeek: null };
    const points = trend([untagged]);
    const day = on(points, '2026-10-25');
    expect(day.measuredWeight).toBe(64);
    expect(day.measuredDate).toBe('2026-10-25');
    // goal start line: 75 - 15 * 27 / 84
    expect(day.weight).toBe(70.2);
  });

  test('a checkpoint weigh-in plots on its checkpoint day, or on its real day when that is earlier', () => {
    const late = trend([checkpoint(4, 64, utc(10, 25), { enteredOn: utc(10, 30) })]);
    expect(on(late, '2026-10-25').measuredWeight).toBe(64);
    expect(on(late, '2026-10-30').measuredWeight).toBeNull();

    const early = trend([checkpoint(4, 64, utc(10, 25), { enteredOn: utc(10, 23) })], {
      from: utc(10, 22),
      to: utc(10, 26),
    });
    expect(on(early, '2026-10-23').measuredWeight).toBe(64);
    expect(on(early, '2026-10-25').measuredWeight).toBeNull();
  });

  test('a same-day resubmission keeps the latest write', () => {
    const first = { ...week4, weight: 65, date: utc(10, 25) };
    const second = { ...week4, weight: 64, date: new Date(utc(10, 25).getTime() + 3600000) };
    const point = on(trend([first, second]), '2026-10-25');
    expect(point.measuredWeight).toBe(64);
    expect(point.weight).toBe(64);
  });

  test('a goal end before the anchor means the target', () => {
    const points = trend([week4], { goalEnd: utc(10, 20), from: utc(10, 25), to: utc(10, 25) });
    expect(points[0].weight).toBe(60);
  });

  test('future buckets keep the empty shape', () => {
    const points = trend([], { today: utc(11, 1), now: utc(11, 1), from: utc(11, 1), to: utc(11, 3) });
    expect(points[1]).toEqual({
      label: '2 Nov',
      date: '',
      weight: 0,
      measuredWeight: null,
      measuredDate: null,
    });
  });
});
