#!/usr/bin/env node
// One-time backfill renaming already-seeded MilestoneTask docs from the old
// "Walk" manual checkbox to "Log Exercise" (see utils/seedGoalTimeline.js's
// DEFAULT_DAILY_TASKS and EXERCISE_TASK_TITLE).
//
// seedGoalTimeline is intentionally idempotent - it only inserts
// MilestoneTask docs for NEWLY seeded date ranges (a fresh goal, or a
// renewal's newly-extended days). It never rewrites tasks already inserted
// under the old "Walk" definition, so every patient whose goal timeline was
// seeded before this change still has a stale "Walk" task on every one of
// their already-seeded daily milestones (past AND future, since the whole
// cycle's days are all seeded up front on plan activation) - the client only
// ever renders whatever title actually comes back from the API, so no
// amount of app/backend redeploying fixes this without also touching the
// data itself.
//
// Matches on the exact old triple (title/metric/icon), not just title, so a
// dietician-authored custom task that happens to also be titled "Walk"
// (there's no uniqueness constraint stopping that) is left alone.
//
// Safe to run repeatedly - a doc already renamed to 'Log Exercise' no longer
// matches the query and is skipped.
//
// Usage:
//   node scripts/maintenance/backfill-log-exercise-task-title.js

require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../../config/database');
const MilestoneTask = require('../../models/MilestoneTask');

async function main() {
  console.log('Connecting to MongoDB...');
  await connectDB();
  console.log('Connected.\n');

  const query = { title: 'Walk', metric: '30 min', icon: 'walk' };
  const stale = await MilestoneTask.find(query).select('_id').lean();
  console.log(`Found ${stale.length} stale 'Walk' MilestoneTask document(s).`);

  if (stale.length > 0) {
    const result = await MilestoneTask.updateMany(query, {
      $set: { title: 'Log Exercise', metric: '', icon: 'exercise' },
    });
    console.log(`Updated ${result.modifiedCount} document(s).`);
  }

  await mongoose.disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error('backfill-log-exercise-task-title failed unexpectedly:', err);
  process.exit(1);
});
