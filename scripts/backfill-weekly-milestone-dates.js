/**
 * Backfill Migration Script: Correct already-seeded 'weekly' Milestone
 * documents whose `date` was set to the START of that week (goalStart, +7,
 * +14, ...) instead of its END (goalStart+6, +13, +20, ...) - see
 * utils/seedGoalTimeline.js's weekly-milestone loop, fixed alongside this
 * script. Because utils/timelinePayload.js sorts milestones by
 * { date: 1, sortOrder: 1 }, a weekly doc dated on a week's first day sorted
 * in right after that week's first daily milestone instead of after all 7,
 * so "Week 1" appeared between day 1 and day 2 of the timeline instead of
 * at the end of the week.
 *
 * Safe to re-run: recomputes each weekly doc's date from its own week
 * number (parsed from its title, "Week N") and its goal's startDate, so
 * running it again on an already-corrected doc is a no-op.
 *
 * Run once after deploying the seedGoalTimeline.js fix:
 *   node scripts/backfill-weekly-milestone-dates.js
 */

require('dotenv').config();
const mongoose = require('mongoose');
const config = require('../config/environment');

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function toDateOnly(d) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

async function run() {
  try {
    console.log('Connecting to MongoDB...');
    await mongoose.connect(config.mongoUri || process.env.MONGODB_URI);
    console.log('Connected.');

    const { Goal, Milestone } = require('../models');

    const weeklyMilestones = await Milestone.find({ type: 'weekly' });
    console.log(`Found ${weeklyMilestones.length} weekly milestone(s) to check.`);

    const goalCache = new Map();
    let fixed = 0;
    let alreadyCorrect = 0;
    let skipped = 0;

    for (const milestone of weeklyMilestones) {
      const weekMatch = /^Week (\d+)$/.exec(milestone.title || '');
      if (!weekMatch) {
        console.warn(`  Skipping milestone ${milestone._id} - unrecognized title "${milestone.title}"`);
        skipped++;
        continue;
      }
      const weekNum = parseInt(weekMatch[1], 10);

      const goalId = milestone.goalId.toString();
      let goal = goalCache.get(goalId);
      if (goal === undefined) {
        goal = await Goal.findById(milestone.goalId).select('startDate');
        goalCache.set(goalId, goal || null);
      }
      if (!goal) {
        console.warn(`  Skipping milestone ${milestone._id} - goal ${goalId} not found`);
        skipped++;
        continue;
      }

      const goalStart = toDateOnly(goal.startDate);
      const correctDate = new Date(goalStart.getTime() + (weekNum * 7 - 1) * MS_PER_DAY);

      if (milestone.date.getTime() === correctDate.getTime()) {
        alreadyCorrect++;
        continue;
      }

      milestone.date = correctDate;
      await milestone.save();
      fixed++;
    }

    console.log(
      `Done. Fixed: ${fixed}, already correct: ${alreadyCorrect}, skipped: ${skipped}.`
    );
    process.exit(0);
  } catch (error) {
    console.error('Backfill failed:', error);
    process.exit(1);
  }
}

run();
