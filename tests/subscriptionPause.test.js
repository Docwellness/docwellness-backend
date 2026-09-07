const {
  isPausedOn,
  pauseShiftForDate,
  effectiveContentDate,
  totalShiftDays,
  currentOrUpcomingPause,
  editablePause,
  dayDiff,
} = require('../utils/subscriptionPause');

const D = (s) => new Date(`${s}T00:00:00.000Z`);
const iso = (d) => (d ? d.toISOString().slice(0, 10) : null);

// The spec example: today 07.09, pause 08.09 -> 11.09 (3 days).
const example = [{ startDate: D('2026-09-08'), resumeDate: D('2026-09-11') }];

describe('subscriptionPause maths', () => {
  test('isPausedOn - start inclusive, resume exclusive', () => {
    expect(isPausedOn(example, D('2026-09-07'))).toBe(false);
    expect(isPausedOn(example, D('2026-09-08'))).toBe(true);
    expect(isPausedOn(example, D('2026-09-10'))).toBe(true);
    expect(isPausedOn(example, D('2026-09-11'))).toBe(false);
  });

  test('pauseShiftForDate - 0 before/inside, full length once ended', () => {
    expect(pauseShiftForDate(example, D('2026-09-07'))).toBe(0);
    expect(pauseShiftForDate(example, D('2026-09-09'))).toBe(0);
    expect(pauseShiftForDate(example, D('2026-09-11'))).toBe(3);
    expect(pauseShiftForDate(example, D('2026-10-01'))).toBe(3);
  });

  test('effectiveContentDate - the spec example', () => {
    expect(iso(effectiveContentDate(example, D('2026-09-07')))).toBe('2026-09-07');
    expect(effectiveContentDate(example, D('2026-09-09'))).toBeNull(); // paused
    // resume day serves the paused start day's content
    expect(iso(effectiveContentDate(example, D('2026-09-11')))).toBe('2026-09-08');
    expect(iso(effectiveContentDate(example, D('2026-09-12')))).toBe('2026-09-09');
  });

  test('stacked pauses accumulate', () => {
    const two = [
      { startDate: D('2026-09-08'), resumeDate: D('2026-09-11') }, // 3d
      { startDate: D('2026-09-20'), resumeDate: D('2026-09-22') }, // 2d
    ];
    expect(pauseShiftForDate(two, D('2026-09-15'))).toBe(3);
    expect(pauseShiftForDate(two, D('2026-09-25'))).toBe(5);
    expect(iso(effectiveContentDate(two, D('2026-09-25')))).toBe('2026-09-20');
    expect(totalShiftDays(two)).toBe(5);
  });

  test('currentOrUpcomingPause / editablePause', () => {
    expect(iso(currentOrUpcomingPause(example, D('2026-09-05')).startDate)).toBe('2026-09-08');
    expect(iso(currentOrUpcomingPause(example, D('2026-09-09')).startDate)).toBe('2026-09-08');
    expect(currentOrUpcomingPause(example, D('2026-09-20'))).toBeNull();

    expect(editablePause(example, D('2026-09-09'))).not.toBeNull();
    expect(editablePause(example, D('2026-09-12'))).toBeNull(); // already resumed
  });

  test('dayDiff', () => {
    expect(dayDiff(D('2026-09-08'), D('2026-09-11'))).toBe(3);
    expect(dayDiff(D('2026-09-11'), D('2026-09-08'))).toBe(-3);
  });

  test('malformed windows are ignored', () => {
    const bad = [
      { startDate: D('2026-09-10'), resumeDate: D('2026-09-08') }, // resume before start
      { startDate: null, resumeDate: D('2026-09-08') },
      { startDate: D('2026-09-08'), resumeDate: D('2026-09-11') }, // the only good one
    ];
    expect(totalShiftDays(bad)).toBe(3);
  });
});
