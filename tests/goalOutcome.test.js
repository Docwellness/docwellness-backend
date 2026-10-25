const { computeGoalOutcome } = require('../utils/goalOutcome');

const outcome = (args) => computeGoalOutcome({ adherence30d: 0.8, ...args });

describe('computeGoalOutcome', () => {
  test('loss goal reached: weight at or below target', () => {
    expect(outcome({ startValue: 70, targetValue: 65, currentValue: 64.6 })).toEqual({
      state: 'achieved',
      direction: 'loss',
      kgMoved: 5.4,
      kgPending: null,
      adherencePct: 80,
    });
  });

  test('loss goal exactly at target counts as reached', () => {
    expect(outcome({ startValue: 70, targetValue: 65, currentValue: 65 }).state).toBe('achieved');
  });

  test('loss goal pending: kg still to lose, to one decimal', () => {
    expect(outcome({ startValue: 70, targetValue: 65, currentValue: 67.3 })).toMatchObject({
      state: 'pending',
      direction: 'loss',
      kgMoved: 2.7,
      kgPending: 2.3,
    });
  });

  test('loss goal where the weight moved the wrong way has no kgMoved', () => {
    expect(outcome({ startValue: 70, targetValue: 65, currentValue: 71 })).toMatchObject({
      state: 'pending',
      kgMoved: null,
      kgPending: 6,
    });
  });

  test('gain goal pending', () => {
    expect(outcome({ startValue: 55, targetValue: 60, currentValue: 58.5 })).toMatchObject({
      state: 'pending',
      direction: 'gain',
      kgMoved: 3.5,
      kgPending: 1.5,
    });
  });

  test('gain goal reached', () => {
    expect(outcome({ startValue: 55, targetValue: 60, currentValue: 60.2 })).toMatchObject({
      state: 'achieved',
      direction: 'gain',
      kgMoved: 5.2,
      kgPending: null,
    });
  });

  test('maintain goal inside the 0.5 kg band is achieved, with no kgMoved', () => {
    expect(outcome({ startValue: 65, targetValue: 65, currentValue: 65.4 })).toMatchObject({
      state: 'achieved',
      direction: 'maintain',
      kgMoved: null,
      kgPending: null,
    });
  });

  test('maintain goal outside the band is pending with the distance', () => {
    expect(outcome({ startValue: 65, targetValue: 65, currentValue: 64.4 })).toMatchObject({
      state: 'pending',
      direction: 'maintain',
      kgPending: 0.6,
    });
  });

  test('a custom tolerance moves the maintain band', () => {
    expect(
      outcome({ startValue: 65, targetValue: 65, currentValue: 65.8, kgTolerance: 1 }).state
    ).toBe('achieved');
  });

  test.each([[undefined], [null], [Number.NaN], [Infinity]])(
    'a missing or non-finite current weight (%s) is unknown with no kg figure',
    (currentValue) => {
      expect(outcome({ startValue: 70, targetValue: 65, currentValue })).toEqual({
        state: 'unknown',
        direction: null,
        kgMoved: null,
        kgPending: null,
        adherencePct: 80,
      });
    }
  );

  test('a goal without a start value is unknown rather than guessed', () => {
    expect(outcome({ startValue: undefined, targetValue: 65, currentValue: 66 }).state).toBe('unknown');
  });

  test('adherence is a whole percent, and null when there are no milestones to measure', () => {
    expect(outcome({ startValue: 70, targetValue: 65, currentValue: 66, adherence30d: 0.82 }).adherencePct).toBe(82);
    expect(outcome({ startValue: 70, targetValue: 65, currentValue: 66, adherence30d: null }).adherencePct).toBeNull();
    expect(outcome({ startValue: 70, targetValue: 65, currentValue: 66, adherence30d: undefined }).adherencePct).toBeNull();
  });

  test('zero adherence is reported as 0, not hidden', () => {
    expect(outcome({ startValue: 70, targetValue: 65, currentValue: 66, adherence30d: 0 }).adherencePct).toBe(0);
  });

  test('kg figures are rounded to one decimal', () => {
    const result = outcome({ startValue: 70.04, targetValue: 65, currentValue: 66.666 });
    expect(result.kgMoved).toBe(3.4);
    expect(result.kgPending).toBe(1.7);
  });
});
