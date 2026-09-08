/**
 * Rebuild a patient's Goal Journey timeline from scratch off their diet
 * plan cycle(s).
 *
 * Use when the stored Goal.endDate / Milestone.date values have drifted -
 * e.g. a patient whose timeline was mangled by the OLD in-place
 * subscription-pause date mutation (now superseded by derive-on-read, see
 * utils/timelinePayload.js + utils/subscriptionPause.shiftDateForPauses).
 * seedGoalTimeline() only ever creates-or-extends a goal, never repairs
 * one, and unshift-paused-goal-dates.js can't recover a timeline that was
 * shifted with a pause length different from the current one - so a drifted
 * timeline has to be dropped and reseeded.
 *
 * Deletes the patient's Goal(s) + Milestones + MilestoneTasks + CheckIns,
 * then replays seedGoalTimeline() over every DietPlan cycle in cycleNumber
 * order (the first call creates the goal, each later one extends it) -
 * exactly the sequence activateDietPlan produces on a fresh signup + each
 * renewal. DietPlan.pauses is left untouched; the reseeded dates are
 * pristine originals that the read path shifts virtually.
 *
 * CheckIns are dropped too (they key off the old milestone/task _ids, which
 * change on reseed) - adherence/streak restart from zero for this patient.
 *
 * Connects with the same prod TLS setup as cleanup-prod-test-users.js /
 * unshift-paused-goal-dates.js - run it inside the prod container with
 * prod's MONGODB_URI / MONGODB_TLS_CA_BASE64 already in the environment.
 *
 *   Dry run:  node scripts/reseed-goal-timeline.js --email patient@x.com
 *   Apply:    node scripts/reseed-goal-timeline.js --email patient@x.com --execute
 *             node scripts/reseed-goal-timeline.js --patient <patientId> --execute
 */

require('dns').setServers(['8.8.8.8', '1.1.1.1']);
require('dotenv').config();
const connectDB = require('../config/database');
const { User, DietPlan, Goal, Milestone, MilestoneTask, CheckIn } = require('../models');
const { seedGoalTimeline } = require('../utils/seedGoalTimeline');

const argValue = (flag) => {
  const i = process.argv.indexOf(flag);
  return i > -1 ? process.argv[i + 1] : null;
};
const EXECUTE = process.argv.includes('--execute');
const EMAIL = argValue('--email');
const PATIENT_ID = argValue('--patient');
const iso = (d) => new Date(d).toISOString().slice(0, 10);

(async () => {
  if (!EMAIL && !PATIENT_ID) {
    console.error('Pass --email <patientEmail> or --patient <patientId>');
    process.exit(1);
  }

  await connectDB();

  const patient = PATIENT_ID
    ? await User.findById(PATIENT_ID).select('_id email role')
    : await User.findOne({ email: EMAIL, role: 'patient' }).select('_id email role');
  if (!patient || patient.role !== 'patient') {
    console.error(`No patient found for ${PATIENT_ID || EMAIL}`);
    process.exit(1);
  }
  console.log(`Patient: ${patient.email} (${patient._id})`);

  const plans = await DietPlan.find({ patientId: patient._id })
    .sort({ cycleNumber: 1 })
    .populate('request');
  console.log(
    `  ${plans.length} diet plan cycle(s): ` +
      plans.map((p) => `#${p.cycleNumber || 1}/${p.status}`).join(', ')
  );

  const seedable = plans.filter(
    (p) => Array.isArray(p.weekSchedule) && p.weekSchedule.length > 0
  );
  if (seedable.length === 0) {
    console.error('  no cycle has a weekSchedule - nothing to seed a timeline from');
    process.exit(1);
  }

  const goals = await Goal.find({ patientId: patient._id }).select('_id endDate status').lean();
  const goalIds = goals.map((g) => g._id);
  const milestoneIds = (
    await Milestone.find({ goalId: { $in: goalIds } }).select('_id').lean()
  ).map((m) => m._id);
  const taskCount = await MilestoneTask.countDocuments({ milestoneId: { $in: milestoneIds } });
  const checkInCount = await CheckIn.countDocuments({ patientId: patient._id });

  console.log(
    `\n  DELETE: ${goals.length} goal(s), ${milestoneIds.length} milestone(s), ` +
      `${taskCount} task(s), ${checkInCount} check-in(s)`
  );
  console.log(
    '  RESEED from: ' +
      seedable
        .map((p) => {
          const ws = p.weekSchedule;
          return `${iso(ws[0].startDate)}..${iso(ws[ws.length - 1].endDate)}`;
        })
        .join('  ->  ')
  );

  if (!EXECUTE) {
    console.log('\nDRY RUN - re-run with --execute to apply');
    process.exit(0);
  }

  await Promise.all([
    MilestoneTask.deleteMany({ milestoneId: { $in: milestoneIds } }),
    CheckIn.deleteMany({ patientId: patient._id }),
  ]);
  await Milestone.deleteMany({ goalId: { $in: goalIds } });
  await Goal.deleteMany({ patientId: patient._id });
  console.log('  cleared existing timeline.');

  for (const plan of seedable) {
    // seedGoalTimeline is idempotent-per-call: first call creates the goal
    // (start = this cycle's week-1 start, end = its last week end), each
    // later call with a further-out end date extends it and seeds only the
    // newly covered range - see utils/seedGoalTimeline.js.
    // eslint-disable-next-line no-await-in-loop
    const goal = await seedGoalTimeline(plan);
    console.log(
      `  cycle #${plan.cycleNumber || 1}: ` +
        (goal
          ? `goal ${iso(goal.startDate)}..${iso(goal.endDate)}`
          : 'skipped (no target weight / no weekSchedule)')
    );
  }

  const activeGoal = await Goal.findOne({ patientId: patient._id, status: 'active' }).lean();
  if (activeGoal) {
    const ms = await Milestone.find({ goalId: activeGoal._id })
      .sort({ date: 1 })
      .select('date type')
      .lean();
    const byType = ms.reduce((acc, m) => ({ ...acc, [m.type]: (acc[m.type] || 0) + 1 }), {});
    console.log(
      `\n  final timeline: ${ms.length} milestone(s) ` +
        `${ms.length ? `${iso(ms[0].date)} .. ${iso(ms[ms.length - 1].date)}` : ''} ` +
        `| ${JSON.stringify(byType)}`
    );
    console.log(`  goal.endDate = ${iso(activeGoal.endDate)} (stored original; read path adds pause shift)`);
  }

  console.log('\nDONE');
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
