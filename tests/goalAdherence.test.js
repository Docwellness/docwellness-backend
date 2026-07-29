const { connectTestDb, disconnectTestDb, clearTestDb } = require('./helpers/testDb');

let createPatient;
let Goal, Milestone, MilestoneTask, CheckIn, Progress;
let goalAdherence;

beforeAll(async () => {
  await connectTestDb();
  ({ createPatient } = require('./helpers/factories'));
  ({ Goal, Milestone, MilestoneTask, CheckIn, Progress } = require('../models'));
  goalAdherence = require('../utils/goalAdherence');
});

afterEach(async () => {
  await clearTestDb();
});

afterAll(async () => {
  await disconnectTestDb();
});

function utcDate(str) {
  return new Date(`${str}T00:00:00.000Z`);
}

async function makeGoal(patientId, overrides = {}) {
  return Goal.create({
    patientId,
    title: 'Reach 64 kg',
    startValue: 74,
    currentValue: 74,
    targetValue: 64,
    unit: 'kg',
    startDate: utcDate('2026-07-01'),
    endDate: utcDate('2026-08-15'),
    status: 'active',
    ...overrides,
  });
}

async function makeDailyMilestoneWithTasks(goalId, dateStr, taskCount = 4) {
  const milestone = await Milestone.create({
    goalId,
    type: 'daily',
    title: dateStr,
    date: utcDate(dateStr),
    sortOrder: 0,
  });
  const tasks = [];
  for (let i = 0; i < taskCount; i++) {
    tasks.push(
      await MilestoneTask.create({
        milestoneId: milestone._id,
        title: `Task ${i}`,
        sortOrder: i,
      })
    );
  }
  return { milestone, tasks };
}

async function checkIn(patientId, task, milestoneId, dateStr) {
  return CheckIn.create({
    patientId,
    taskId: task._id,
    milestoneId,
    loggedAt: utcDate(dateStr),
  });
}

describe('computeMilestoneStatus', () => {
  test('future milestone is upcoming', () => {
    const today = utcDate('2026-07-15');
    const milestone = { date: utcDate('2026-07-20') };
    expect(goalAdherence.computeMilestoneStatus(milestone, null, today)).toBe('upcoming');
  });

  test("today's milestone is active regardless of adherence", () => {
    const today = utcDate('2026-07-15');
    const milestone = { date: utcDate('2026-07-15') };
    expect(goalAdherence.computeMilestoneStatus(milestone, { tasksTotal: 4, adherence: 0 }, today)).toBe(
      'active'
    );
  });

  test('past milestone with adherence >= 0.6 is completed', () => {
    const today = utcDate('2026-07-15');
    const milestone = { date: utcDate('2026-07-10') };
    expect(
      goalAdherence.computeMilestoneStatus(milestone, { tasksTotal: 4, adherence: 0.75 }, today)
    ).toBe('completed');
  });

  test('past milestone with adherence < 0.6 is missed', () => {
    const today = utcDate('2026-07-15');
    const milestone = { date: utcDate('2026-07-10') };
    expect(
      goalAdherence.computeMilestoneStatus(milestone, { tasksTotal: 4, adherence: 0.25 }, today)
    ).toBe('missed');
  });

  test('past milestone with zero tasks (weekly/monthly node) defaults to completed', () => {
    const today = utcDate('2026-07-15');
    const milestone = { date: utcDate('2026-07-08') };
    expect(goalAdherence.computeMilestoneStatus(milestone, { tasksTotal: 0, adherence: 0 }, today)).toBe(
      'completed'
    );
  });
});

describe('computeAdherenceForMilestones', () => {
  test('correctly counts tasksDone/tasksTotal/adherence per milestone', async () => {
    const patient = await createPatient();
    const goal = await makeGoal(patient._id);
    const { milestone, tasks } = await makeDailyMilestoneWithTasks(goal._id, '2026-07-10', 4);
    await checkIn(patient._id, tasks[0], milestone._id, '2026-07-10');
    await checkIn(patient._id, tasks[1], milestone._id, '2026-07-10');

    const map = await goalAdherence.computeAdherenceForMilestones(patient._id, [milestone._id]);
    const entry = map.get(milestone._id.toString());

    expect(entry.tasksTotal).toBe(4);
    expect(entry.tasksDone).toBe(2);
    expect(entry.adherence).toBe(0.5);
  });

  test('a milestone with no tasks has adherence 0, not NaN', async () => {
    const patient = await createPatient();
    const goal = await makeGoal(patient._id);
    const milestone = await Milestone.create({
      goalId: goal._id,
      type: 'weekly',
      title: 'Week 1',
      date: utcDate('2026-07-07'),
      sortOrder: 900,
    });

    const map = await goalAdherence.computeAdherenceForMilestones(patient._id, [milestone._id]);
    const entry = map.get(milestone._id.toString());

    expect(entry.tasksTotal).toBe(0);
    expect(entry.adherence).toBe(0);
  });
});

describe('computeGoalStreak', () => {
  test('returns 0 when the patient has no active goal', async () => {
    const patient = await createPatient();
    expect(await goalAdherence.computeGoalStreak(patient._id)).toBe(0);
  });

  test('counts consecutive fully-done days ending yesterday when today is not yet done', async () => {
    const patient = await createPatient();
    const goal = await makeGoal(patient._id);
    const fixedToday = utcDate('2026-07-15');

    // 07-13 and 07-14 fully done, 07-15 (today) not done at all, 07-12 missed.
    for (const [dateStr, doneCount] of [
      ['2026-07-12', 1],
      ['2026-07-13', 4],
      ['2026-07-14', 4],
      ['2026-07-15', 0],
    ]) {
      const { milestone, tasks } = await makeDailyMilestoneWithTasks(goal._id, dateStr, 4);
      for (let i = 0; i < doneCount; i++) {
        await checkIn(patient._id, tasks[i], milestone._id, dateStr);
      }
    }

    const streak = await goalAdherence.computeGoalStreak(patient._id, fixedToday);
    expect(streak).toBe(2); // 07-14 and 07-13, breaking at 07-12
  });
});

describe('predictedEndDate', () => {
  test('returns null with fewer than 2 weight entries', async () => {
    const patient = await createPatient();
    const goal = await makeGoal(patient._id);
    await Progress.create({ patientId: patient._id, date: new Date(), weight: 74 });

    expect(await goalAdherence.predictedEndDate(goal)).toBeNull();
  });

  test('projects a future date along a consistent downward trend', async () => {
    const patient = await createPatient();
    const goal = await makeGoal(patient._id, { targetValue: 70 });

    // Losing exactly 0.1kg/day for 10 days: 74 -> 73.1
    const base = Date.now() - 9 * 24 * 60 * 60 * 1000;
    for (let i = 0; i < 10; i++) {
      await Progress.create({
        patientId: patient._id,
        date: new Date(base + i * 24 * 60 * 60 * 1000),
        weight: 74 - i * 0.1,
      });
    }

    const predicted = await goalAdherence.predictedEndDate(goal);
    expect(predicted).not.toBeNull();
    expect(predicted.getTime()).toBeGreaterThan(Date.now());
  });

  test('returns null when the trend moves away from the target', async () => {
    const patient = await createPatient();
    const goal = await makeGoal(patient._id, { targetValue: 64 }); // wants to LOSE weight

    // Gaining weight instead - moving away from a lose-weight goal.
    const base = Date.now() - 9 * 24 * 60 * 60 * 1000;
    for (let i = 0; i < 10; i++) {
      await Progress.create({
        patientId: patient._id,
        date: new Date(base + i * 24 * 60 * 60 * 1000),
        weight: 74 + i * 0.1,
      });
    }

    expect(await goalAdherence.predictedEndDate(goal)).toBeNull();
  });
});

describe('computeGoalStats', () => {
  test('returns { goal: null, stats: null } when there is no active goal', async () => {
    const patient = await createPatient();
    const result = await goalAdherence.computeGoalStats(patient._id);
    expect(result.goal).toBeNull();
    expect(result.stats).toBeNull();
  });

  test('assembles goal + stats for a patient with check-in history', async () => {
    const patient = await createPatient();
    const goal = await makeGoal(patient._id);
    const { milestone, tasks } = await makeDailyMilestoneWithTasks(goal._id, '2026-07-01', 4);
    await checkIn(patient._id, tasks[0], milestone._id, '2026-07-01');
    await checkIn(patient._id, tasks[1], milestone._id, '2026-07-01');
    await checkIn(patient._id, tasks[2], milestone._id, '2026-07-01');

    const result = await goalAdherence.computeGoalStats(patient._id);

    expect(result.goal._id.toString()).toBe(goal._id.toString());
    expect(result.stats).toHaveProperty('streak');
    expect(result.stats).toHaveProperty('weekDone');
    expect(result.stats).toHaveProperty('weekTotal');
    expect(result.stats).toHaveProperty('adherence30d');
    expect(result.stats).toHaveProperty('daysToGo');
    expect(result.stats.daysToGo).toBeGreaterThanOrEqual(0);
  });
});
