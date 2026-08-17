// Goal Journey Timeline adherence/streak/pace computation - all done on
// read (no materialized daily_adherence table, see utils/seedGoalTimeline.js
// and the plan doc's reasoning: patient-scale data here doesn't need a
// nightly batch job, and computing on read can't drift from the underlying
// CheckIn documents).
//
// This is a THIRD, intentionally distinct streak metric from the two
// already in this codebase - controllers/patient/progressController.js's
// calorie-budget streak, and controllers/dietician/dietPlanController.js's
// meal-logged streak. Always call this one `goalStreak`, never bare
// "streak", to keep it unambiguous next to those two.

const { MS_PER_DAY } = require('./trackingBuckets');
const {
  Milestone,
  MilestoneTask,
  CheckIn,
  Goal,
  Progress,
  MealLog,
  WaterLog,
  ExerciseLog,
  ExercisePlan,
} = require('../models');
const {
  MEAL_LINKED_TASK_TITLES,
  WATER_TASK_TITLE,
  EXERCISE_TASK_TITLE,
  SUPPLEMENTS_TASK_TITLE,
} = require('./seedGoalTimeline');
const { resolveDayGroupForDate } = require('./dayGroups');

const ADHERENCE_COMPLETE_THRESHOLD = 0.6;

function dateKeyUTC(date) {
  return new Date(date).toISOString().slice(0, 10);
}

function startOfTodayUTC() {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/**
 * Single source of truth for "is this task done" - a meal-linked task (see
 * MEAL_LINKED_TASK_TITLES, seedGoalTimeline.js) is done when the patient's
 * real MealLog for that milestone's day has a matching mealType entry; the
 * Water Intake task (WATER_TASK_TITLE) is done when that day's WaterLog
 * total reaches its goal, with a 0..1 progress fraction alongside it since
 * water isn't a discrete yes/no like a meal being logged; Log Exercise
 * (EXERCISE_TASK_TITLE) is done when every exercise assigned for that day's
 * dayGroup (via the patient's active ExercisePlan) has a matching
 * ExerciseLog entry, same 0..1 progress fraction reasoning as water; every
 * other task (Supplements, Sleep) is done via the existing CheckIn flow.
 * Used by both computeAdherenceForMilestones (aggregate stats) and
 * timelinePayload.js (per-task shaping for the API response), so adherence/
 * streak and what the client displays as "done" can never disagree.
 *
 * `milestones` just needs `_id` and `date` on each entry (lean docs are
 * fine even without `type` selected - only daily milestones ever have
 * MilestoneTask docs at all, so no type filter is needed here).
 * Returns Map<taskId string, { done, linked, loggedNote, progress }>.
 */
async function computeTaskDoneMap(patientId, milestones) {
  const result = new Map();
  if (!milestones || milestones.length === 0) return result;

  const milestoneIds = milestones.map((m) => m._id);
  const tasks = await MilestoneTask.find({ milestoneId: { $in: milestoneIds } })
    .select('milestoneId title')
    .lean();
  if (tasks.length === 0) return result;

  const taskIds = tasks.map((t) => t._id);
  const checkIns = await CheckIn.find({ taskId: { $in: taskIds } }).select('taskId').lean();
  const checkedInIds = new Set(checkIns.map((c) => c.taskId.toString()));

  const dates = milestones.map((m) => new Date(m.date)).sort((a, b) => a - b);
  const [mealLogs, waterLogs, exerciseLogs, exercisePlan] = await Promise.all([
    MealLog.find({
      patientId,
      date: { $gte: dates[0], $lte: dates[dates.length - 1] },
    }).lean(),
    WaterLog.find({
      patientId,
      date: { $gte: dateKeyUTC(dates[0]), $lte: dateKeyUTC(dates[dates.length - 1]) },
    }).lean(),
    ExerciseLog.find({
      patientId,
      date: { $gte: dates[0], $lte: dates[dates.length - 1] },
    }).lean(),
    // Single doc, not date-ranged - dailyExercises is keyed by dayGroup
    // (Monday/Tuesday/Wednesday/Thursday), same recurring-per-week shape
    // DietPlan uses, not one entry per calendar date.
    ExercisePlan.findOne({ patientId, status: 'Active' }).select('dailyExercises').lean(),
  ]);
  const dailyExercises = exercisePlan?.dailyExercises || [];

  const mealsByDateKey = new Map();
  for (const log of mealLogs) {
    const key = dateKeyUTC(log.date);
    if (!mealsByDateKey.has(key)) mealsByDateKey.set(key, new Map());
    const byType = mealsByDateKey.get(key);
    for (const meal of log.meals || []) {
      // A single serving-time slot can hold more than one logged recipe
      // (see dietController.js's submitMealLog, which overwrites-or-appends
      // per (servingTime, recipeId) pair - e.g. Breakfast: Idli + Boiled
      // Egg, each logged separately). Aggregating instead of the previous
      // last-write-wins Map.set() - that silently discarded every earlier
      // entry's calories for the same mealType, undercounting a slot's
      // real "X kcal" loggedNote (and the day summary's total kcal logged)
      // whenever more than one recipe was logged under it.
      const existing = byType.get(meal.mealType);
      if (existing) {
        existing.caloriesConsumed = (existing.caloriesConsumed || 0) + (meal.caloriesConsumed || 0);
      } else {
        byType.set(meal.mealType, { ...meal });
      }
    }
  }
  const waterByDateKey = new Map(waterLogs.map((w) => [w.date, w]));

  const exercisesByDateKey = new Map();
  for (const log of exerciseLogs) {
    const key = dateKeyUTC(log.date);
    const ids = new Set((log.exercises || []).map((e) => e.exerciseId?.toString()).filter(Boolean));
    exercisesByDateKey.set(key, ids);
  }

  const milestoneById = new Map(milestones.map((m) => [m._id.toString(), m]));
  for (const t of tasks) {
    const milestone = milestoneById.get(t.milestoneId.toString());
    const dateKey = milestone ? dateKeyUTC(milestone.date) : null;

    if (MEAL_LINKED_TASK_TITLES.has(t.title)) {
      const loggedMeal = dateKey ? mealsByDateKey.get(dateKey)?.get(t.title) : null;
      result.set(t._id.toString(), {
        done: Boolean(loggedMeal),
        linked: true,
        loggedNote: loggedMeal
          ? loggedMeal.caloriesConsumed
            ? `${loggedMeal.caloriesConsumed} kcal`
            : 'Logged'
          : null,
        progress: null,
      });
      continue;
    }

    if (t.title === WATER_TASK_TITLE) {
      const waterLog = dateKey ? waterByDateKey.get(dateKey) : null;
      const total = waterLog?.totalAmount ?? 0;
      const goal = waterLog?.goal ?? 2500;
      const progress = goal > 0 ? Math.min(1, total / goal) : 0;
      result.set(t._id.toString(), {
        done: total >= goal,
        linked: true,
        loggedNote: `${(total / 1000).toFixed(1)}/${(goal / 1000).toFixed(1)} L`,
        progress,
      });
      continue;
    }

    if (t.title === EXERCISE_TASK_TITLE) {
      // dailyExercises is a recurring per-dayGroup list (Monday/Tuesday/
      // Wednesday/Thursday), not one entry per calendar date - resolve
      // which group this milestone's actual date falls into, same mapping
      // exerciseController.js's getTodayExerciseStats uses.
      const dayGroup = milestone ? resolveDayGroupForDate(new Date(milestone.date)) : null;
      const plannedCount = dayGroup
        ? dailyExercises.filter((e) => e.dayGroup === dayGroup).length
        : 0;
      const loggedCount = dateKey ? exercisesByDateKey.get(dateKey)?.size ?? 0 : 0;
      // No exercises assigned this day at all - nothing to miss, same
      // "no tasks -> completed" reasoning computeMilestoneStatus already
      // applies to a milestone with zero MilestoneTask docs.
      const done = plannedCount > 0 ? loggedCount >= plannedCount : true;
      result.set(t._id.toString(), {
        done,
        linked: true,
        loggedNote: plannedCount > 0 ? `${loggedCount}/${plannedCount} logged` : null,
        progress: plannedCount > 0 ? Math.min(1, loggedCount / plannedCount) : null,
      });
      continue;
    }

    result.set(t._id.toString(), {
      done: checkedInIds.has(t._id.toString()),
      linked: false,
      loggedNote: null,
      progress: null,
    });
  }

  return result;
}

/**
 * Batches task + done-state lookups for a set of milestones into one pass
 * (not one per milestone), returning
 * Map<milestoneId string, { tasksTotal, tasksDone, adherence }>.
 * adherence is 0 for a milestone with no tasks at all (weekly/monthly/
 * end_goal nodes don't get default tasks - see seedGoalTimeline.js) rather
 * than NaN/undefined. `milestonesHint`, if given (each needs `_id`+`date`),
 * skips the internal Milestone.find lookup for callers that already have
 * the docs loaded.
 */
async function computeAdherenceForMilestones(patientId, milestoneIds, milestonesHint) {
  const result = new Map();
  if (!milestoneIds || milestoneIds.length === 0) return result;

  const milestones =
    milestonesHint || (await Milestone.find({ _id: { $in: milestoneIds } }).select('date').lean());
  const taskDoneMap = await computeTaskDoneMap(patientId, milestones);

  const tasks = await MilestoneTask.find({ milestoneId: { $in: milestoneIds } })
    .select('milestoneId title')
    .lean();
  const tasksByMilestone = new Map();
  for (const t of tasks) {
    // Optional, no-log-source - excluded from the client's own "x/N tasks
    // done" tally too (see SUPPLEMENTS_TASK_TITLE), so a day with every
    // required task done but Supplements left unchecked must read as
    // 'completed' here, not 'partial'.
    if (t.title === SUPPLEMENTS_TASK_TITLE) continue;
    const key = t.milestoneId.toString();
    if (!tasksByMilestone.has(key)) tasksByMilestone.set(key, []);
    tasksByMilestone.get(key).push(t._id.toString());
  }

  for (const milestoneId of milestoneIds) {
    const key = milestoneId.toString();
    const taskIdsForM = tasksByMilestone.get(key) || [];
    const tasksTotal = taskIdsForM.length;
    const tasksDone = taskIdsForM.filter((id) => taskDoneMap.get(id)?.done).length;
    const adherence = tasksTotal === 0 ? 0 : tasksDone / tasksTotal;
    result.set(key, { tasksTotal, tasksDone, adherence });
  }

  return result;
}

/**
 * 'completed' | 'partial' | 'missed' | 'active' | 'upcoming'. A milestone
 * with no tasks at all (a weekly/monthly/end_goal node the dietician
 * hasn't customized) can't be judged by adherence, so past ones default to
 * 'completed' rather than always showing as 'missed' for having nothing to
 * check off.
 *
 * Deliberately all-or-nothing-or-something rather than the
 * ADHERENCE_COMPLETE_THRESHOLD ratio this used to use (>= 0.6 -> completed,
 * else missed): the timeline's dots are meant to read at a glance as "did
 * you do everything", "did you do nothing", or "you did some of it" - a
 * 60%-done day and a 100%-done day both showing the identical green check
 * looked indistinguishable from a day that was actually fully closed out,
 * and a 25%-done day looked identical to a day with literally nothing
 * logged. tasksDone===tasksTotal and tasksDone===0 are equivalent whether
 * counted at this function's raw per-task granularity or the client's
 * conceptual grouping (see docwellness-user's TaskGroups - Log Meal's 7
 * serving-time tasks collapse into one "Log Meal" group there), since
 * "every task done" and "no task done" mean the same thing under either
 * counting scheme - only the exact boundary within 'partial' would ever
 * differ, and 'partial' doesn't distinguish degrees anyway.
 */
function computeMilestoneStatus(milestone, adherenceEntry, today = startOfTodayUTC()) {
  const milestoneDate = new Date(milestone.date);
  const mKey = dateKeyUTC(milestoneDate);
  const todayKey = dateKeyUTC(today);

  if (mKey === todayKey) return 'active';
  if (milestoneDate > today) return 'upcoming';

  const tasksTotal = adherenceEntry?.tasksTotal ?? 0;
  if (tasksTotal === 0) return 'completed';
  const tasksDone = adherenceEntry?.tasksDone ?? 0;
  if (tasksDone <= 0) return 'missed';
  if (tasksDone >= tasksTotal) return 'completed';
  return 'partial';
}

/**
 * Consecutive daily milestones ending today or yesterday with adherence
 * >= 0.6. If today hasn't reached the threshold yet (it may still be in
 * progress), counting starts from yesterday instead of breaking the streak
 * on an incomplete-but-not-yet-failed today.
 */
async function computeGoalStreak(patientId, today = startOfTodayUTC()) {
  const goal = await Goal.findOne({ patientId, status: 'active' });
  if (!goal) return 0;

  const dailyMilestones = await Milestone.find({
    goalId: goal._id,
    type: 'daily',
    date: { $lte: today },
  })
    .sort({ date: -1 })
    .limit(60)
    .lean();

  if (dailyMilestones.length === 0) return 0;

  const adherenceMap = await computeAdherenceForMilestones(
    patientId,
    dailyMilestones.map((m) => m._id),
    dailyMilestones
  );

  let startIndex = 0;
  const mostRecent = dailyMilestones[0];
  if (dateKeyUTC(mostRecent.date) === dateKeyUTC(today)) {
    const todayAdherence = adherenceMap.get(mostRecent._id.toString())?.adherence ?? 0;
    if (todayAdherence < ADHERENCE_COMPLETE_THRESHOLD) {
      startIndex = 1;
    }
  }

  let streak = 0;
  for (let i = startIndex; i < dailyMilestones.length; i++) {
    const entry = adherenceMap.get(dailyMilestones[i]._id.toString());
    if ((entry?.adherence ?? 0) >= ADHERENCE_COMPLETE_THRESHOLD) {
      streak++;
    } else {
      break;
    }
  }
  return streak;
}

/**
 * Linear regression over the last 21 days of Progress.weight entries,
 * projected to goal.targetValue. Returns null when there's too little data
 * to fit a trend, the trend is flat, or the trend is moving away from the
 * target (all of which make a projected date meaningless rather than just
 * optimistic) - callers should treat null as "not enough signal yet", not
 * an error.
 */
async function predictedEndDate(goal) {
  const since = new Date(Date.now() - 21 * MS_PER_DAY);
  const entries = await Progress.find({
    patientId: goal.patientId,
    weight: { $ne: null },
    date: { $gte: since },
  })
    .sort({ date: 1 })
    .select('date weight')
    .lean();

  if (entries.length < 2) return null;

  const x0 = entries[0].date.getTime();
  const points = entries.map((e) => ({
    x: (e.date.getTime() - x0) / MS_PER_DAY,
    y: e.weight,
  }));

  const n = points.length;
  const sumX = points.reduce((s, p) => s + p.x, 0);
  const sumY = points.reduce((s, p) => s + p.y, 0);
  const sumXY = points.reduce((s, p) => s + p.x * p.y, 0);
  const sumXX = points.reduce((s, p) => s + p.x * p.x, 0);
  const denom = n * sumXX - sumX * sumX;
  if (denom === 0) return null; // all entries on the same day - no slope

  const slope = (n * sumXY - sumX * sumY) / denom; // kg per day
  const intercept = (sumY - slope * sumX) / n;
  if (slope === 0) return null;

  const daysFromFirst = (goal.targetValue - intercept) / slope;
  if (!Number.isFinite(daysFromFirst) || daysFromFirst < 0) return null;

  return new Date(x0 + daysFromFirst * MS_PER_DAY);
}

/**
 * Ties the above together into the TimelineStats shape the API contract
 * needs (see docs/goal-timeline response contract). Safe to call even when
 * the patient has no active goal - callers should treat a null `goal`
 * return as "nothing to show yet".
 */
async function computeGoalStats(patientId, today = startOfTodayUTC()) {
  const goal = await Goal.findOne({ patientId, status: 'active' });
  if (!goal) return { goal: null, stats: null };

  const weekAgo = new Date(today.getTime() - 6 * MS_PER_DAY);
  const thirtyDaysAgo = new Date(today.getTime() - 29 * MS_PER_DAY);

  const [goalStreak, weekMilestones, last30Milestones, predicted] = await Promise.all([
    computeGoalStreak(patientId, today),
    Milestone.find({ goalId: goal._id, type: 'daily', date: { $gte: weekAgo, $lte: today } })
      .select('date')
      .lean(),
    Milestone.find({
      goalId: goal._id,
      type: 'daily',
      date: { $gte: thirtyDaysAgo, $lte: today },
    })
      .select('date')
      .lean(),
    predictedEndDate(goal),
  ]);

  const weekAdherence = await computeAdherenceForMilestones(
    patientId,
    weekMilestones.map((m) => m._id),
    weekMilestones
  );
  const weekDone = weekMilestones.filter(
    (m) => (weekAdherence.get(m._id.toString())?.adherence ?? 0) >= ADHERENCE_COMPLETE_THRESHOLD
  ).length;

  const last30Adherence = await computeAdherenceForMilestones(
    patientId,
    last30Milestones.map((m) => m._id),
    last30Milestones
  );
  const adherenceValues = last30Milestones.map(
    (m) => last30Adherence.get(m._id.toString())?.adherence ?? 0
  );
  const adherence30d =
    adherenceValues.length === 0
      ? 0
      : Math.round((adherenceValues.reduce((s, v) => s + v, 0) / adherenceValues.length) * 100) /
        100;

  const daysToGo = Math.max(0, Math.round((goal.endDate.getTime() - today.getTime()) / MS_PER_DAY));
  // Days elapsed since the goal started, clamped to the goal's own total
  // span so a client showing "X completed / Y remaining" never sums to more
  // than the actual goal length (e.g. querying the day the goal starts).
  const totalDays = Math.max(
    1,
    Math.round((goal.endDate.getTime() - goal.startDate.getTime()) / MS_PER_DAY)
  );
  const daysElapsed = Math.min(
    totalDays,
    Math.max(0, Math.round((today.getTime() - goal.startDate.getTime()) / MS_PER_DAY))
  );
  const onPace = predicted ? predicted <= goal.endDate : null;

  return {
    goal,
    stats: {
      streak: goalStreak,
      weekDone,
      weekTotal: weekMilestones.length,
      adherence30d,
      daysToGo,
      daysElapsed,
      predictedEndDate: predicted,
      onPace,
    },
  };
}

module.exports = {
  ADHERENCE_COMPLETE_THRESHOLD,
  computeTaskDoneMap,
  computeAdherenceForMilestones,
  computeMilestoneStatus,
  computeGoalStreak,
  predictedEndDate,
  computeGoalStats,
};
