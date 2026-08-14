/**
 * One-time cleanup: removes dev/test User accounts that leaked into prod
 * via the original full-clone cutover to the self-hosted Mongo instance
 * (see docs/db-migration-oracle.md) - not real signups, and already unable
 * to log in against prod's new dedicated Supabase project anyway (their
 * supabaseUserId still points at the old dev Supabase project).
 *
 * Cascades through every collection that references a deleted user's _id,
 * not just the User document itself - see DELETE_PLAN below for the exact
 * field per collection. Goal -> Milestone -> MilestoneTask is a real
 * dependency chain (Milestone has no direct patientId, only goalId), so
 * those two cascade off the Goal ids actually deleted, not off the user
 * ids directly.
 *
 * Usage:
 *   node scripts/cleanup-prod-test-users.js            # dry run
 *   node scripts/cleanup-prod-test-users.js --execute  # actually delete
 *
 * Targets whichever database MONGODB_URI points at - there is no
 * prod-specific override, on purpose: run this with prod's own
 * MONGODB_URI/MONGODB_TLS_CA_BASE64 already in the environment (e.g. via
 * `docker exec` inside the prod container), the same way
 * createDieticianAccount.js does, rather than this script guessing.
 */

require('dns').setServers(['8.8.8.8', '1.1.1.1']);
require('dotenv').config();
const connectDB = require('../config/database');

const EXECUTE = process.argv.includes('--execute');

// Confirmed dev/test artifacts (see the release-plan discussion this
// script came out of) - not a query/heuristic, a fixed, reviewed list, so
// this can never accidentally sweep up a real signup that merely looks
// test-like.
const TEST_USER_EMAILS = [
  'testfrau@test.de',
  'test.renewal.1784727563829@docwellness.fit',
  'test.renewal.1784727628417@docwellness.fit',
  'paawarbhushan29+verify1784812492@gmail.com',
  'pawarbhushan08@gmail.com',
];

async function main() {
  console.log(EXECUTE ? '=== EXECUTING prod test-user cleanup ===' : '=== DRY RUN (pass --execute to delete) ===');

  await connectDB();
  console.log('Connected.');

  const {
    User, Chat, Conversation, CheckIn, CustomFoodRequest, DietPlan, DietPlanRequest,
    ExerciseLog, ExercisePlan, FirstConsultation, Goal, JourneyImage, ManualPaymentProof,
    MealLog, Milestone, MilestoneTask, NeedAttentionLog, Notification, Nudge, Progress,
    WaterLog, Review,
  } = require('../models');

  const users = await User.find({ email: { $in: TEST_USER_EMAILS } }).select('_id email role').lean();
  if (users.length === 0) {
    console.log('No matching users found - nothing to do.');
    process.exit(0);
  }
  console.log(`\nFound ${users.length} test user(s):`);
  users.forEach((u) => console.log(`  ${u.email} (${u.role}) - ${u._id}`));

  const ids = users.map((u) => u._id);
  const summary = [];
  const del = async (label, Model, filter) => {
    const count = await Model.countDocuments(filter);
    summary.push({ collection: label, matched: count });
    if (EXECUTE && count > 0) await Model.deleteMany(filter);
    return count;
  };

  await del('chats', Chat, { $or: [{ senderId: { $in: ids } }, { receiverId: { $in: ids } }] });
  await del('conversations', Conversation, { 'participants.userId': { $in: ids } });
  await del('checkins', CheckIn, { patientId: { $in: ids } });
  await del('customfoodrequests', CustomFoodRequest, { patientId: { $in: ids } });
  await del('dietplans', DietPlan, { patientId: { $in: ids } });
  await del('dietplanrequests', DietPlanRequest, { patient: { $in: ids } });
  await del('exerciselogs', ExerciseLog, { patientId: { $in: ids } });
  await del('exerciseplans', ExercisePlan, { patientId: { $in: ids } });
  await del('firstconsultations', FirstConsultation, { patient: { $in: ids } });
  await del('journeyimages', JourneyImage, { patientId: { $in: ids } });
  await del('manualpaymentproofs', ManualPaymentProof, { patient: { $in: ids } });
  await del('meallogs', MealLog, { patientId: { $in: ids } });
  await del('needattentionlogs', NeedAttentionLog, { patientId: { $in: ids } });
  await del('notifications', Notification, { userId: { $in: ids } });
  await del('nudges', Nudge, { patientId: { $in: ids } });
  await del('progresses', Progress, { patientId: { $in: ids } });
  await del('waterlogs', WaterLog, { patientId: { $in: ids } });
  await del('reviews', Review, { patientId: { $in: ids } });

  // Goal -> Milestone -> MilestoneTask cascade: Milestone/MilestoneTask
  // have no direct patientId, only a chain back through goalId/milestoneId.
  const goalIds = (await Goal.find({ patientId: { $in: ids } }).select('_id').lean()).map((g) => g._id);
  summary.push({ collection: 'goals', matched: goalIds.length });
  const milestoneIds = goalIds.length
    ? (await Milestone.find({ goalId: { $in: goalIds } }).select('_id').lean()).map((m) => m._id)
    : [];
  summary.push({ collection: 'milestones', matched: milestoneIds.length });
  const milestoneTaskCount = milestoneIds.length
    ? await MilestoneTask.countDocuments({ milestoneId: { $in: milestoneIds } })
    : 0;
  summary.push({ collection: 'milestonetasks', matched: milestoneTaskCount });

  if (EXECUTE) {
    if (milestoneIds.length) await MilestoneTask.deleteMany({ milestoneId: { $in: milestoneIds } });
    if (goalIds.length) await Milestone.deleteMany({ goalId: { $in: goalIds } });
    if (goalIds.length) await Goal.deleteMany({ patientId: { $in: ids } });
  }

  await del('users', User, { _id: { $in: ids } });

  console.log('\n=== SUMMARY ===');
  console.table(summary);

  if (!EXECUTE) {
    console.log('\nThis was a dry run - nothing deleted. Re-run with --execute to actually delete.');
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('Cleanup failed:', err);
  process.exit(1);
});
