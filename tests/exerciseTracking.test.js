const {
  resolveTrackingType,
  resolveSecondsPerRep,
  TRACKING_REPS,
  TRACKING_DURATION,
} = require('../utils/exerciseTracking');
const { estimateRepsDurationMinutes, calcCaloriesBurned } = require('../utils/exerciseHelpers');

describe('resolveTrackingType', () => {
  test.each([
    'Push-Ups',
    'Sit-Ups',
    'Abs Crunches',
    'Bodyweight Squats',
    'Walking Lunges',
    'Glute Bridges',
    'Bicycle Crunches',
    'Tricep Dips (Chair)',
    'Burpees',
    'Sun Salutations (Surya Namaskar)',
  ])('%s is logged as sets x reps', (name) => {
    expect(resolveTrackingType({ name, category: 'Strength' })).toBe(TRACKING_REPS);
  });

  test.each(['Plank', 'Wall Sit', 'Jump Rope (Skipping)', 'High Knees', 'Jumping Jacks', 'Mountain Climbers'])(
    '%s is logged as a duration',
    (name) => {
      // Plank / Wall Sit are 'Strength' by category but are timed holds.
      expect(resolveTrackingType({ name, category: 'Strength' })).toBe(TRACKING_DURATION);
    }
  );

  test('name matching ignores case and surrounding spaces', () => {
    expect(resolveTrackingType({ name: '  push-ups ', category: 'Other' })).toBe(TRACKING_REPS);
  });

  test('an explicit trackingType on the catalog entry wins over everything', () => {
    expect(resolveTrackingType({ name: 'Push-Ups', category: 'Strength', trackingType: 'duration' })).toBe(
      TRACKING_DURATION
    );
    expect(resolveTrackingType({ name: 'Jump Rope (Skipping)', trackingType: 'reps' })).toBe(TRACKING_REPS);
  });

  test('unknown exercises fall back to category: Strength = reps, everything else timed', () => {
    expect(resolveTrackingType({ name: 'Dumbbell Rows', category: 'Strength' })).toBe(TRACKING_REPS);
    expect(resolveTrackingType({ name: 'Zumba', category: 'Cardio' })).toBe(TRACKING_DURATION);
    expect(resolveTrackingType({ name: 'Hamstring Stretch', category: 'Flexibility' })).toBe(TRACKING_DURATION);
    expect(resolveTrackingType({ name: 'Something', category: 'Other' })).toBe(TRACKING_DURATION);
    expect(resolveTrackingType(null)).toBe(TRACKING_DURATION);
  });
});

describe('resolveSecondsPerRep', () => {
  test('catalog value, then built-in table, then 3s default', () => {
    expect(resolveSecondsPerRep({ name: 'Push-Ups', secondsPerRep: 4 })).toBe(4);
    expect(resolveSecondsPerRep({ name: 'Burpees' })).toBe(5);
    expect(resolveSecondsPerRep({ name: 'Unknown Move' })).toBe(3);
  });
});

describe('estimateRepsDurationMinutes + calories', () => {
  test('3 x 12 tricep dips: about 3.3 min elapsed (movement + rest), about 14 kcal at 68 kg, not 20 minutes', () => {
    const minutes = estimateRepsDurationMinutes({ sets: 3, reps: 12, secondsPerRep: 3 });
    // 36 reps * 3s = 108s of movement + 2 rests * 45s = 90s
    expect(minutes).toBeCloseTo((108 + 90) / 60, 5);
    const kcal = calcCaloriesBurned({ met: 3.8, weightKg: 68, durationMinutes: Math.round(minutes * 10) / 10 });
    expect(kcal).toBe(14);
  });

  test('a single set has no rest', () => {
    expect(estimateRepsDurationMinutes({ sets: 1, reps: 10, secondsPerRep: 3 })).toBeCloseTo(0.5, 5);
  });

  test('defaults to 3 x 12 at 3s per rep when nothing is given', () => {
    expect(estimateRepsDurationMinutes({})).toBeCloseTo((3 * 12 * 3 + 2 * 45) / 60, 5);
  });

  test('burpees take longer per rep than crunches', () => {
    const burpees = estimateRepsDurationMinutes({ sets: 3, reps: 10, secondsPerRep: 5 });
    const crunches = estimateRepsDurationMinutes({ sets: 3, reps: 10, secondsPerRep: 2.5 });
    expect(burpees).toBeGreaterThan(crunches);
  });
});
