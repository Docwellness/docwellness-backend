/**
 * What a patient achieved against their goal once the plan has ended: pure
 * numbers for the app to word with fixed templates (nothing is generated, and
 * nothing here is logged - these are the patient's own health values).
 *
 * Direction comes from the goal itself (Goal has no direction field): start
 * above target is a loss goal, below is a gain goal, equal is maintain.
 */

// A maintain goal counts as reached within this many kg of the target - ordinary scale and hydration noise.
const MAINTAIN_TOLERANCE_KG = 0.5;

const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);
const round1 = (value) => Math.round(value * 10) / 10;

function directionOf(startValue, targetValue) {
  if (startValue > targetValue) return 'loss';
  if (startValue < targetValue) return 'gain';
  return 'maintain';
}

/**
 * @param {object} args
 * @param {number} args.startValue  goal start weight
 * @param {number} args.targetValue goal target weight
 * @param {number} args.currentValue latest logged weight
 * @param {number|null} args.adherence30d 0..1, null when the goal has no daily milestones in the window
 * @param {number} [args.kgTolerance] maintain band in kg
 * @returns {{ state: 'achieved'|'pending'|'unknown', direction: string|null,
 *   kgMoved: number|null, kgPending: number|null, adherencePct: number|null }}
 */
function computeGoalOutcome({
  startValue,
  targetValue,
  currentValue,
  adherence30d,
  kgTolerance = MAINTAIN_TOLERANCE_KG,
}) {
  const adherencePct = isNumber(adherence30d) ? Math.round(adherence30d * 100) : null;
  const unknown = { state: 'unknown', direction: null, kgMoved: null, kgPending: null, adherencePct };
  if (!isNumber(currentValue) || !isNumber(startValue) || !isNumber(targetValue)) return unknown;

  const direction = directionOf(startValue, targetValue);
  const reached =
    direction === 'loss'
      ? currentValue <= targetValue
      : direction === 'gain'
        ? currentValue >= targetValue
        : Math.abs(currentValue - targetValue) <= kgTolerance;

  let kgMoved = null;
  if (direction !== 'maintain') {
    const moved = round1(direction === 'loss' ? startValue - currentValue : currentValue - startValue);
    kgMoved = moved > 0 ? moved : null;
  }

  return {
    state: reached ? 'achieved' : 'pending',
    direction,
    kgMoved,
    kgPending: reached ? null : round1(Math.abs(targetValue - currentValue)),
    adherencePct,
  };
}

module.exports = { computeGoalOutcome, MAINTAIN_TOLERANCE_KG };
