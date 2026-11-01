/**
 * Calorie buckets and the requested range are UTC calendar days
 * (utils/trackingBuckets.js). Every date is built with Date.UTC so the tests
 * pass on any host timezone.
 */
const { buildDateBuckets, resolveRequestedRange } = require('../utils/trackingBuckets');

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const utc = (y, m, d) => new Date(Date.UTC(y, m - 1, d));
const endOfDay = (date) => new Date(date.getTime() + MS_PER_DAY - 1);
const rangeOf = (start, days) => buildDateBuckets(start, endOfDay(new Date(start.getTime() + (days - 1) * MS_PER_DAY)));

describe('buildDateBuckets granularity', () => {
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
