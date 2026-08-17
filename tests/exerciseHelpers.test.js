const { estimateDurationMinutes, calcCaloriesBurned } = require('../utils/exerciseHelpers');

describe('estimateDurationMinutes', () => {
  test('uses the plan duration directly when there are no sets', () => {
    expect(estimateDurationMinutes({ planDurationMinutes: 10, sets: null, reps: null, secondsPerRep: null })).toBe(
      10
    );
  });

  test('multiplies plan duration by sets when both are assigned', () => {
    expect(estimateDurationMinutes({ planDurationMinutes: 1, sets: 3, reps: null, secondsPerRep: null })).toBe(3);
  });

  test('falls back to reps * DEFAULT_SECONDS_PER_REP when secondsPerRep is missing (the catalog default today)', () => {
    // Bicycle Crunches: 3 sets * 20 reps, no plan duration, no catalog
    // secondsPerRep - this used to return null and block the log entirely.
    const minutes = estimateDurationMinutes({
      planDurationMinutes: null,
      sets: 3,
      reps: 20,
      secondsPerRep: null,
    });
    expect(minutes).not.toBeNull();
    expect(minutes).toBeGreaterThan(0);
    expect(minutes).toBeCloseTo((3 * 20 * 3) / 60, 5); // 3s/rep default
  });

  test('prefers the catalog secondsPerRep over the default when present', () => {
    const minutes = estimateDurationMinutes({
      planDurationMinutes: null,
      sets: 2,
      reps: 10,
      secondsPerRep: 5,
    });
    expect(minutes).toBeCloseTo((5 * 10 * 2) / 60, 5);
  });

  test('reps with no sets assumes a single set', () => {
    const minutes = estimateDurationMinutes({
      planDurationMinutes: null,
      sets: null,
      reps: 20,
      secondsPerRep: null,
    });
    expect(minutes).toBeCloseTo((3 * 20 * 1) / 60, 5);
  });

  test('returns null only when there is genuinely nothing to estimate from (no duration, no reps)', () => {
    expect(
      estimateDurationMinutes({ planDurationMinutes: null, sets: 3, reps: null, secondsPerRep: null })
    ).toBeNull();
    expect(
      estimateDurationMinutes({ planDurationMinutes: null, sets: null, reps: null, secondsPerRep: null })
    ).toBeNull();
  });
});

describe('calcCaloriesBurned', () => {
  test('computes met * weightKg * durationHours', () => {
    expect(calcCaloriesBurned({ met: 6, weightKg: 70, durationMinutes: 30 })).toBe(Math.round(6 * 70 * 0.5));
  });

  test('returns null for invalid input', () => {
    expect(calcCaloriesBurned({ met: null, weightKg: 70, durationMinutes: 30 })).toBeNull();
    expect(calcCaloriesBurned({ met: 6, weightKg: 70, durationMinutes: 0 })).toBeNull();
  });
});
