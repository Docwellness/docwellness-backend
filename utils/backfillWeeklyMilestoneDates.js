/**
 * Corrects already-seeded 'weekly' Milestone documents whose `date` was set
 * to the START of that week (goalStart, +7, +14, ...) instead of its END
 * (goalStart+6, +13, +20, ...) - see utils/seedGoalTimeline.js's weekly-
 * milestone loop, fixed alongside this. Because utils/timelinePayload.js
 * sorts milestones by { date: 1, sortOrder: 1 }, a weekly doc dated on a
 * week's first day sorted in right after that week's first daily milestone
 * instead of after all 7, so "Week 1" appeared between day 1 and day 2 of
 * the timeline instead of at the end of the week.
 *
 * Safe to re-run: recomputes each weekly doc's date from its own week
 * number (parsed from its title, "Week N") and its goal's startDate, so
 * running it again on an already-corrected doc is a no-op.
 *
 * Shared by scripts/backfill-weekly-milestone-dates.js (standalone CLI run)
 * and the one-off /api/internal/backfill-weekly-milestone-dates route
 * (triggered over HTTPS against a live deployment's own DB connection).
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function toDateOnly(d) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

async function backfillWeeklyMilestoneDates() {
  const { Goal, Milestone } = require('../models');

  const weeklyMilestones = await Milestone.find({ type: 'weekly' });

  const goalCache = new Map();
  let fixed = 0;
  let alreadyCorrect = 0;
  let skipped = 0;
  const skippedIds = [];

  for (const milestone of weeklyMilestones) {
    const weekMatch = /^Week (\d+)$/.exec(milestone.title || '');
    if (!weekMatch) {
      skipped++;
      skippedIds.push(milestone._id.toString());
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
      skipped++;
      skippedIds.push(milestone._id.toString());
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

  return { total: weeklyMilestones.length, fixed, alreadyCorrect, skipped, skippedIds };
}

module.exports = { backfillWeeklyMilestoneDates };
