/**
 * One-off migration. The subscription-pause feature used to mutate
 * Goal.endDate + Milestone.date in place on every pause create / edit /
 * cancel (controllers/dietician/subscriptionPauseController.js
 * `shiftSatelliteDates`). That drifted whenever an op partially failed.
 *
 * The dates are now DERIVED on read from the stored originals + the pause
 * windows (utils/timelinePayload + goalAdherence `shiftDateForPauses`), so
 * the previously-mutated docs would be double-counted.
 *
 * This script reverses the in-place shift for every patient who currently
 * has a pause window on an Active diet plan: subtract that patient's total
 * pause length from the active Goal's endDate and from every milestone that
 * sits on or after the (already-shifted) pause start. Idempotent-ish - runs
 * once, right after deploying the derive-on-read change.
 *
 *   Dry run:   node scripts/unshift-paused-goal-dates.js
 *   Apply:     node scripts/unshift-paused-goal-dates.js --execute
 *   One patient: add  --patient <patientId>
 */

require('dns').setServers(['8.8.8.8', '1.1.1.1']);
require('dotenv').config();
const connectDB = require('../config/database');
const { DietPlan, Goal, Milestone } = require('../models');
const {
  normalizePauses,
  totalShiftDays,
  addDays,
  normDate,
} = require('../utils/subscriptionPause');

const EXECUTE = process.argv.includes('--execute');
const patientArgIdx = process.argv.indexOf('--patient');
const ONLY_PATIENT = patientArgIdx > -1 ? process.argv[patientArgIdx + 1] : null;

(async () => {
  await connectDB();

  const planQuery = { status: 'Active', 'pauses.0': { $exists: true } };
  if (ONLY_PATIENT) planQuery.patientId = ONLY_PATIENT;
  const plans = await DietPlan.find(planQuery).select('patientId pauses').lean();

  // Group pause windows by patient (a renewal can spread them over cycles).
  const byPatient = new Map();
  for (const p of plans) {
    const key = String(p.patientId);
    byPatient.set(key, [...(byPatient.get(key) || []), ...(p.pauses || [])]);
  }

  console.log(`${byPatient.size} patient(s) with an active pause window\n`);
  let goalsFixed = 0;
  let milestonesFixed = 0;

  for (const [patientId, rawPauses] of byPatient) {
    const pauses = normalizePauses(rawPauses);
    const shift = totalShiftDays(pauses);
    if (shift === 0) continue;
    const firstStart = pauses[0].startDate;

    const goal = await Goal.findOne({ patientId, status: 'active' });
    if (!goal) {
      console.log(`  patient ${patientId}: no active goal, skipping`);
      continue;
    }

    const newEnd = addDays(goal.endDate, -shift);
    // The old code shifted milestones with (original) date >= pause start;
    // they now sit at >= pauseStart + shift.
    const cutoff = addDays(firstStart, shift);
    const shifted = await Milestone.find({
      goalId: goal._id,
      date: { $gte: cutoff },
    })
      .select('_id date')
      .lean();

    console.log(
      `  patient ${patientId}: shift ${shift}d | goal.endDate ` +
        `${normDate(goal.endDate).toISOString().slice(0, 10)} -> ` +
        `${newEnd.toISOString().slice(0, 10)} | ${shifted.length} milestone(s)`
    );

    if (!EXECUTE) continue;

    goal.endDate = newEnd;
    await goal.save();
    goalsFixed += 1;

    if (shifted.length) {
      await Milestone.bulkWrite(
        shifted.map((m) => ({
          updateOne: {
            filter: { _id: m._id },
            update: { $set: { date: addDays(m.date, -shift) } },
          },
        }))
      );
      milestonesFixed += shifted.length;
    }
  }

  console.log(
    `\n${EXECUTE ? 'DONE' : 'DRY RUN'} - goals: ${goalsFixed}, milestones: ${milestonesFixed}`
  );
  if (!EXECUTE) console.log('re-run with --execute to apply');
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
