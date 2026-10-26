/**
 * The Progress charts must reach back to the patient's FIRST plan, not just
 * the currently active renewal cycle - otherwise repurchasing (Week 5)
 * hides weeks 1-4. See utils/trackingBuckets.js resolveHistoryStartDate and
 * controllers/patient/progressController.js.
 */
const {
  resolveHistoryStartDate,
  resolveRequestedRange,
} = require('../utils/trackingBuckets');

const day = (iso) => {
  const d = new Date(`${iso}T00:00:00`);
  d.setHours(0, 0, 0, 0);
  return d;
};
const plan = (iso) => ({ weekSchedule: [{ startDate: day(iso) }] });

describe('resolveHistoryStartDate', () => {
  it('uses the first cycle, not the renewal cycle that is active now', () => {
    const cycle1 = plan('2026-09-14');
    const cycle2 = plan('2026-10-12'); // Week 5 repurchase
    const activeStart = day('2026-10-12');
    expect(resolveHistoryStartDate([cycle2, cycle1], activeStart)).toEqual(day('2026-09-14'));
  });

  it('falls back to the active plan start when no plan resolves a start', () => {
    const activeStart = day('2026-10-12');
    expect(resolveHistoryStartDate([{}, { weekSchedule: [] }], activeStart)).toEqual(activeStart);
    expect(resolveHistoryStartDate([], activeStart)).toEqual(activeStart);
    expect(resolveHistoryStartDate(undefined, activeStart)).toEqual(activeStart);
  });

  it('is null when there is no plan history and no fallback', () => {
    expect(resolveHistoryStartDate([], null)).toBeNull();
  });

  it('never starts later than the active plan', () => {
    const activeStart = day('2026-09-01');
    expect(resolveHistoryStartDate([plan('2026-10-12')], activeStart)).toEqual(activeStart);
  });

  it('lets the default range and clamp reach back to week 1 after a renewal', () => {
    const historyStart = resolveHistoryStartDate(
      [plan('2026-10-12'), plan('2026-09-14')],
      day('2026-10-12')
    );
    const today = day('2026-10-26');
    const { startDate } = resolveRequestedRange({}, historyStart, today);
    expect(startDate).toEqual(day('2026-09-14'));
    // A request for even earlier than the first plan is still clamped.
    const clamped = resolveRequestedRange({ startDate: '2026-01-01' }, historyStart, today);
    expect(clamped.startDate).toEqual(day('2026-09-14'));
  });
});
