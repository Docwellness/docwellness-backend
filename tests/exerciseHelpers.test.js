const { estimateDurationMinutes, calcCaloriesBurned } = require('../utils/exerciseHelpers');

describe('estimateDurationMinutes', () => {
  test('uses the plan duration directly when there are no sets', () => {
    expect(estimateDurationMinutes({ planDurationMinutes: 10, sets: null, reps: null, secondsPerRep: null })).toBe(
      10
    );
  });

  test('multiplies plan duration by sets when the plan itself assigns both', () => {
    expect(
      estimateDurationMinutes({ planDurationMinutes: 1, planSets: 3, sets: 3, reps: null, secondsPerRep: null })
    ).toBe(3);
    // The patient did 4 sets of a per-set plan - the count they logged wins.
    expect(
      estimateDurationMinutes({ planDurationMinutes: 1, planSets: 3, sets: 4, reps: null, secondsPerRep: null })
    ).toBe(4);
  });

  test('never multiplies a flat plan duration by the client-sent sets (20 min jump rope stays 20)', () => {
    // Regression: the app's log dialog sends sets=3 reps=12 by default even for a
    // plan item that is just "20 min" - that used to become 60 minutes and 3x the
    // calories (748 kcal instead of ~249 for an 11-MET, 68 kg session).
    const minutes = estimateDurationMinutes({
      planDurationMinutes: 20,
      planSets: null,
      sets: 3,
      reps: 12,
      secondsPerRep: null,
    });
    expect(minutes).toBe(20);
    expect(calcCaloriesBurned({ met: 11, weightKg: 68, durationMinutes: minutes })).toBe(249);
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
