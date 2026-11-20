const {
  parseStartDay,
  earliestStartDay,
  dayToUtcDate,
  addDaysToDay,
  activationDates,
} = require('../utils/planStartDate');
const { lastWeekEndDayOf, endDayOf } = require('../utils/planEnd');

const key = (date) => date.toISOString().slice(0, 10);

describe('parseStartDay', () => {
  test.each(['2026-11-19', '2028-02-29', '2026-12-31'])('accepts %s', (value) => {
    expect(parseStartDay(value)).toBe(value);
  });

  test.each([
    ['impossible day', '2026-02-30'],
    ['no leap day in 2026', '2026-02-29'],
    ['month 13', '2026-13-01'],
    ['ISO with time', '2026-11-19T00:00:00.000Z'],
    ['no zero padding', '2026-1-9'],
    ['slashes', '2026/11/19'],
    ['empty', ''],
    ['null', null],
    ['undefined', undefined],
    ['a number', 20261119],
  ])('rejects %s', (_label, value) => {
    expect(parseStartDay(value)).toBeNull();
  });
});

describe('earliestStartDay', () => {
  test('today is the minimum for a first-time plan', () => {
    expect(earliestStartDay({ now: new Date('2026-11-19T06:00:00.000Z') })).toBe('2026-11-19');
  });

  test('00:30 IST on 20 Nov (18:30 UTC on 19 Nov) accepts 20 Nov', () => {
    expect(earliestStartDay({ now: new Date('2026-11-19T19:00:00.000Z') })).toBe('2026-11-20');
  });

  test('23:30 IST on 19 Nov (18:00 UTC) is still 19 Nov', () => {
    expect(earliestStartDay({ now: new Date('2026-11-19T18:00:00.000Z') })).toBe('2026-11-19');
  });

  test('a renewal starts the day after the running end', () => {
    expect(
      earliestStartDay({ now: new Date('2026-11-19T06:00:00.000Z'), runningEndDay: '2026-11-25' })
    ).toBe('2026-11-26');
  });

  test('a running end in the past does not pull the minimum before today', () => {
    expect(
      earliestStartDay({ now: new Date('2026-11-19T06:00:00.000Z'), runningEndDay: '2026-11-10' })
    ).toBe('2026-11-19');
  });

  test('a running end on a month end rolls to the next month', () => {
    expect(
      earliestStartDay({ now: new Date('2026-11-19T06:00:00.000Z'), runningEndDay: '2026-11-30' })
    ).toBe('2026-12-01');
  });

  test('a running end on a year end rolls to the next year', () => {
    expect(
      earliestStartDay({ now: new Date('2026-12-20T06:00:00.000Z'), runningEndDay: '2026-12-31' })
    ).toBe('2027-01-01');
  });
});

describe('dayToUtcDate and addDaysToDay', () => {
  test('a day key becomes UTC midnight', () => {
    expect(dayToUtcDate('2026-11-19').toISOString()).toBe('2026-11-19T00:00:00.000Z');
  });

  test('adding days crosses month and year ends', () => {
    expect(addDaysToDay('2026-11-30', 1)).toBe('2026-12-01');
    expect(addDaysToDay('2026-12-31', 1)).toBe('2027-01-01');
  });
});

describe('activationDates', () => {
  const dates = activationDates('2026-11-19');

  test('starts at UTC midnight of the picked day', () => {
    expect(dates.startDate.toISOString()).toBe('2026-11-19T00:00:00.000Z');
  });

  test('week 1 runs 19 to 25 Nov', () => {
    expect(key(dates.weekSchedule[0].startDate)).toBe('2026-11-19');
    expect(key(dates.weekSchedule[0].endDate)).toBe('2026-11-25');
  });

  test('four back-to-back weeks, the last ending 16 Dec', () => {
    expect(dates.weekSchedule.map((w) => w.week)).toEqual([1, 2, 3, 4]);
    expect(key(dates.weekSchedule[3].endDate)).toBe('2026-12-16');
    expect(lastWeekEndDayOf(dates.weekSchedule, [])).toBe('2026-12-16');
  });

  test('the subscription expires 30 days later, on 19 Dec', () => {
    expect(endDayOf(dates.subscriptionExpiresAt)).toBe('2026-12-19');
  });
});
