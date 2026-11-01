/**
 * Calorie buckets and the requested range are UTC calendar days
 * (utils/trackingBuckets.js). Every date is built with Date.UTC so the tests
 * pass on any host timezone.
 */
const {
  buildDateBuckets,
  buildDailyBuckets,
  buildCalorieData,
  currentBucketIndex,
  resolveRequestedRange,
} = require('../utils/trackingBuckets');

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const utc = (y, m, d) => new Date(Date.UTC(y, m - 1, d));
const endOfDay = (date) => new Date(date.getTime() + MS_PER_DAY - 1);
const rangeOf = (start, days) => buildDateBuckets(start, endOfDay(new Date(start.getTime() + (days - 1) * MS_PER_DAY)));
const dailyOf = (start, days) =>
  buildDailyBuckets(start, endOfDay(new Date(start.getTime() + (days - 1) * MS_PER_DAY)));

// The calorie chart is always daily (buildDailyBuckets); buildDateBuckets and
// its granularity sizes now describe the weight and BMI series only.
describe('buildDailyBuckets', () => {
  test.each([1, 31, 32, 126, 127, 400])('a %i day range gives one bucket per day', (days) => {
    const start = utc(2025, 12, 20);
    const buckets = dailyOf(start, days);
    expect(buckets).toHaveLength(days);
    expect(buckets[0].start).toEqual(start);
    expect(buckets[days - 1].end).toEqual(endOfDay(new Date(start.getTime() + (days - 1) * MS_PER_DAY)));
    for (let i = 0; i < days; i += 1) {
      expect(buckets[i].startDate).toBe(buckets[i].endDate);
      if (i > 0) expect(buckets[i].start.getTime()).toBe(buckets[i - 1].end.getTime() + 1);
    }
  });

  test('labels each bucket with its short date', () => {
    expect(dailyOf(utc(2026, 10, 30), 3).map((b) => b.label)).toEqual(['30 Oct', '31 Oct', '1 Nov']);
  });
});

describe('buildCalorieData', () => {
  const dailyBuckets = dailyOf(utc(2026, 9, 21), 42);
  // Monday 5 Oct has a 1800 target, Tuesday 6 Oct 1500; every other day none.
  const plannedByDay = new Map([
    ['2026-10-05', 1800],
    ['2026-10-06', 1500],
  ]);

  test('gives one item per day of a 21 Sep - 1 Nov range with exactly the documented fields', () => {
    const data = buildCalorieData({ dailyBuckets, mealLogs: [], plannedByDay });
    expect(data).toHaveLength(42);
    expect(Object.keys(data[0])).toEqual([
      'label',
      'dateRange',
      'startDate',
      'endDate',
      'calories',
      'totalCalories',
      'plannedCalories',
      'daysLogged',
    ]);
    expect(data[0]).toMatchObject({ startDate: '2026-09-21', dateRange: '21 Sep - 21 Sep' });
    expect(data[41]).toMatchObject({ startDate: '2026-11-01', label: '1 Nov' });
  });

  test('a logged day carries its calories and an unlogged day is zero', () => {
    const mealLogs = [{ date: utc(2026, 10, 5), totalCalories: 1840 }];
    const data = buildCalorieData({ dailyBuckets, mealLogs, plannedByDay });
    expect(data[14]).toMatchObject({ startDate: '2026-10-05', calories: 1840, totalCalories: 1840, plannedCalories: 1800, daysLogged: 1 });
    expect(data[15]).toMatchObject({ calories: 0, totalCalories: 0, daysLogged: 0 });
  });

  test('each day carries its own target and a day without one gets 0', () => {
    const data = buildCalorieData({ dailyBuckets, mealLogs: [], plannedByDay });
    expect(data[14].plannedCalories).toBe(1800);
    expect(data[15].plannedCalories).toBe(1500);
    expect(data[0].plannedCalories).toBe(0);
    expect(data[41].plannedCalories).toBe(0);
  });

  test('falls back to the meal sum and sums two docs on one day into one item', () => {
    const mealLogs = [
      { date: utc(2026, 10, 5), meals: [{ caloriesConsumed: 300 }, { caloriesConsumed: 500 }] },
      { date: utc(2026, 10, 5), totalCalories: 1000 },
    ];
    const data = buildCalorieData({ dailyBuckets, mealLogs, plannedByDay });
    expect(data[14]).toMatchObject({ totalCalories: 1800, calories: 900, daysLogged: 2 });
  });
});

describe('currentBucketIndex', () => {
  const buckets = dailyOf(utc(2026, 9, 21), 42);

  test('finds the bucket holding now', () => {
    expect(currentBucketIndex(buckets, new Date(Date.UTC(2026, 10, 1, 9, 30)))).toBe(41);
  });

  test('is -1 when now is outside the range', () => {
    expect(currentBucketIndex(buckets, new Date(Date.UTC(2026, 10, 2, 0, 0)))).toBe(-1);
  });
});

describe('buildDateBuckets granularity (weight and BMI series)', () => {
  test.each([
    [1, 'daily'],
    [31, 'daily'],
    [32, 'weekly'],
    [126, 'weekly'],
    [127, 'monthly'],
  ])('a %i day range is %s', (days, granularity) => {
    expect(rangeOf(utc(2026, 3, 1), days).granularity).toBe(granularity);
  });
});

describe('buildDateBuckets coverage', () => {
  test.each([1, 31, 32, 126, 127, 200])('buckets of a %i day range are contiguous and cover it exactly', (days) => {
    const start = utc(2026, 1, 20);
    const { buckets } = rangeOf(start, days);
    expect(buckets[0].start).toEqual(start);
    expect(buckets[0].startDate).toBe(start.toISOString().slice(0, 10));
    for (let i = 1; i < buckets.length; i += 1) {
      expect(buckets[i].start.getTime()).toBe(buckets[i - 1].end.getTime() + 1);
    }
    const last = buckets[buckets.length - 1];
    expect(last.end).toEqual(endOfDay(new Date(start.getTime() + (days - 1) * MS_PER_DAY)));
  });

  test('daily buckets are one UTC day each and carry their day keys', () => {
    const { buckets } = rangeOf(utc(2026, 10, 30), 3);
    expect(buckets.map((b) => [b.startDate, b.endDate])).toEqual([
      ['2026-10-30', '2026-10-30'],
      ['2026-10-31', '2026-10-31'],
      ['2026-11-01', '2026-11-01'],
    ]);
    expect(buckets.map((b) => b.label)).toEqual(['30 Oct', '31 Oct', '1 Nov']);
  });

  test('the last weekly bucket is partial and ends on the range end', () => {
    // 40 days: five 7-day buckets and a 5-day tail.
    const { buckets, granularity } = rangeOf(utc(2026, 9, 21), 40);
    expect(granularity).toBe('weekly');
    expect(buckets).toHaveLength(6);
    expect(buckets[0]).toMatchObject({ startDate: '2026-09-21', endDate: '2026-09-27' });
    expect(buckets[5]).toMatchObject({ startDate: '2026-10-26', endDate: '2026-10-30' });
  });

  test('month buckets span two years and label the year', () => {
    const { buckets, granularity } = buildDateBuckets(utc(2025, 11, 15), endOfDay(utc(2026, 4, 10)));
    expect(granularity).toBe('monthly');
    expect(buckets.map((b) => b.label)).toEqual(["Nov '25", "Dec '25", "Jan '26", "Feb '26", "Mar '26", "Apr '26"]);
    expect(buckets[0]).toMatchObject({ startDate: '2025-11-15', endDate: '2025-11-30' });
    expect(buckets[5]).toMatchObject({ startDate: '2026-04-01', endDate: '2026-04-10' });
  });
});

describe('resolveRequestedRange', () => {
  const historyStart = utc(2026, 9, 14);
  const today = utc(2026, 10, 26);

  test('defaults to history start .. end of today', () => {
    const { startDate, endDate } = resolveRequestedRange({}, historyStart, today);
    expect(startDate).toEqual(historyStart);
    expect(endDate).toEqual(endOfDay(today));
  });

  test('clamps a start before the history start and an end after today', () => {
    const { startDate, endDate } = resolveRequestedRange(
      { startDate: '2026-01-01', endDate: '2026-12-31' },
      historyStart,
      today
    );
    expect(startDate).toEqual(historyStart);
    expect(endDate).toEqual(endOfDay(today));
  });

  test('does not mutate the dates it was given', () => {
    resolveRequestedRange({}, historyStart, today);
    expect(historyStart).toEqual(utc(2026, 9, 14));
    expect(today).toEqual(utc(2026, 10, 26));
  });
});
