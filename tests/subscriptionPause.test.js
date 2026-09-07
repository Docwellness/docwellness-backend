const {
  isPausedOn,
  pauseShiftForDate,
  effectiveContentDate,
  totalShiftDays,
  currentOrUpcomingPause,
  editablePause,
  dayDiff,
  shiftWeekRangeForPauses,
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

  test('shiftWeekRangeForPauses - week cards move forward by the pause', () => {
    // pause 08.09 -> 12.09 (4 days), aligned to week 5's start.
    const p = [{ startDate: D('2026-09-08'), resumeDate: D('2026-09-12') }];

    const wk4 = shiftWeekRangeForPauses(p, D('2026-09-01'), D('2026-09-07'));
    expect(iso(wk4.startDate)).toBe('2026-09-01'); // before the pause - unchanged
    expect(iso(wk4.endDate)).toBe('2026-09-07');

    const wk5 = shiftWeekRangeForPauses(p, D('2026-09-08'), D('2026-09-14'));
    expect(iso(wk5.startDate)).toBe('2026-09-12'); // +4
    expect(iso(wk5.endDate)).toBe('2026-09-18');

    const wk6 = shiftWeekRangeForPauses(p, D('2026-09-15'), D('2026-09-21'));
    expect(iso(wk6.startDate)).toBe('2026-09-19'); // +4
    expect(iso(wk6.endDate)).toBe('2026-09-25');

    // a pause starting mid-week only pushes that week's end
    const mid = [{ startDate: D('2026-09-10'), resumeDate: D('2026-09-13') }];
    const split = shiftWeekRangeForPauses(mid, D('2026-09-08'), D('2026-09-14'));
    expect(iso(split.startDate)).toBe('2026-09-08');
    expect(iso(split.endDate)).toBe('2026-09-17'); // +3

    // no pauses - identity
    const none = shiftWeekRangeForPauses([], D('2026-09-08'), D('2026-09-14'));
    expect(iso(none.startDate)).toBe('2026-09-08');
    expect(iso(none.endDate)).toBe('2026-09-14');
  });
});
