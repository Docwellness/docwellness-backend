// How an exercise is prescribed and logged - "reps" (sets x repetitions) or
// "duration" (minutes, or a timed hold) - and how long one repetition takes.
// Pure (no model imports) so the Exercise schema, the log controller and the
// scripts can all share it.
//
// Resolution order for trackingType: the catalog entry's own explicit
// `trackingType` (set by a dietician or a script) -> the known-exercise table
// below (the built-in home-workout catalog, see
// scripts/seed-home-workout-exercises.js) -> a category fallback for
// exercises added later (Strength is counted in reps; Cardio / Flexibility /
// Sports / Other are timed).

const TRACKING_REPS = 'reps';
const TRACKING_DURATION = 'duration';

// Typical seconds for ONE repetition including the lowering/raising phase.
// Used only to turn sets x reps into elapsed active time for the calorie
// estimate - see estimateRepsDurationMinutes.
const DEFAULT_SECONDS_PER_REP = 3;

// Built-in catalog, classified by how each exercise is normally prescribed.
// Keys are lower-cased names. `spr` = seconds per repetition (reps-type only).
const KNOWN_EXERCISES = {
  'push-ups': { type: TRACKING_REPS, spr: 3 },
  'sit-ups': { type: TRACKING_REPS, spr: 3 },
  'abs crunches': { type: TRACKING_REPS, spr: 2.5 },
  'bodyweight squats': { type: TRACKING_REPS, spr: 3 },
  'walking lunges': { type: TRACKING_REPS, spr: 3 }, // one rep = one step
  'glute bridges': { type: TRACKING_REPS, spr: 4 }, // includes the hold at the top
  'bicycle crunches': { type: TRACKING_REPS, spr: 2 },
  'tricep dips (chair)': { type: TRACKING_REPS, spr: 3 },
  burpees: { type: TRACKING_REPS, spr: 5 },
  'sun salutations (surya namaskar)': { type: TRACKING_REPS, spr: 45 }, // one rep = one round
  plank: { type: TRACKING_DURATION },
  'wall sit': { type: TRACKING_DURATION },
  'jump rope (skipping)': { type: TRACKING_DURATION },
  'high knees': { type: TRACKING_DURATION },
  'jumping jacks': { type: TRACKING_DURATION },
  'mountain climbers': { type: TRACKING_DURATION },
};

function known(exercise) {
  const name = typeof exercise?.name === 'string' ? exercise.name.trim().toLowerCase() : '';
  return KNOWN_EXERCISES[name] || null;
}

/** 'reps' or 'duration' for a catalog exercise (see resolution order above). */
function resolveTrackingType(exercise) {
  const explicit = exercise?.trackingType;
  if (explicit === TRACKING_REPS || explicit === TRACKING_DURATION) return explicit;
  const k = known(exercise);
  if (k) return k.type;
  return exercise?.category === 'Strength' ? TRACKING_REPS : TRACKING_DURATION;
}

/** Seconds per repetition: the catalog's own value, else the built-in table, else a default. */
function resolveSecondsPerRep(exercise) {
  if (typeof exercise?.secondsPerRep === 'number' && exercise.secondsPerRep > 0) {
    return exercise.secondsPerRep;
  }
  return known(exercise)?.spr ?? DEFAULT_SECONDS_PER_REP;
}

module.exports = {
  TRACKING_REPS,
  TRACKING_DURATION,
  DEFAULT_SECONDS_PER_REP,
  resolveTrackingType,
  resolveSecondsPerRep,
};
