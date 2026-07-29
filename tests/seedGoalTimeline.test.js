const { connectTestDb, disconnectTestDb, clearTestDb } = require('./helpers/testDb');

let createPatient, createDietician;
let Goal, Milestone, MilestoneTask, User, DietPlan;
let seedGoalTimeline;

beforeAll(async () => {
  await connectTestDb();
  ({ createPatient, createDietician } = require('./helpers/factories'));
  ({ Goal, Milestone, MilestoneTask, User, DietPlan } = require('../models'));
  ({ seedGoalTimeline } = require('../utils/seedGoalTimeline'));
});

afterEach(async () => {
  await clearTestDb();
});

afterAll(async () => {
  await disconnectTestDb();
});

async function makeActivePlan(patient, dietician, { startDate, endDate }) {
  // weekSchedule (not the top-level startDate/endDate fields, which
  // activateDietPlan never actually populates) is what seedGoalTimeline
  // resolves dates from - matches real data exactly instead of relying on
  // resolvePlanStartDate/EndDate's fallback branches.
  return DietPlan.create({
    patientId: patient._id,
    dieticianId: dietician._id,
    status: 'Active',
    startDate,
    endDate,
    weekSchedule: [{ week: 1, startDate, endDate }],
  });
}

describe('seedGoalTimeline', () => {
  test('creates a Goal + daily/weekly/monthly/end_goal milestones with default tasks', async () => {
    const patient = await createPatient({
      healthProfile: { bmi: 22, weightIndex: 0, weight: 74, targetWeight: '64' },
    });
    const dietician = await createDietician();
    const startDate = new Date('2026-07-01T00:00:00.000Z');
    const endDate = new Date('2026-07-28T00:00:00.000Z'); // 28-day cycle
    const plan = await makeActivePlan(patient, dietician, { startDate, endDate });

    const goal = await seedGoalTimeline(plan);

    expect(goal).toBeTruthy();
    expect(goal.targetValue).toBe(64);
    expect(goal.startValue).toBe(74);
    expect(goal.status).toBe('active');

    const milestones = await Milestone.find({ goalId: goal._id }).sort({ date: 1 });
    const daily = milestones.filter((m) => m.type === 'daily');
    const weekly = milestones.filter((m) => m.type === 'weekly');
    const monthly = milestones.filter((m) => m.type === 'monthly');
    const endGoal = milestones.filter((m) => m.type === 'end_goal');

    expect(daily).toHaveLength(28); // inclusive of both endpoints
    expect(endGoal).toHaveLength(1);
    expect(endGoal[0].date.toISOString().slice(0, 10)).toBe('2026-07-28');
    expect(weekly.length).toBeGreaterThan(0);
    // A 28-day cycle starting mid-month never reaches a month-end boundary
    // (July 31 falls outside this 07-01..07-28 range) - no monthly node is
    // expected here; see the renewal test below for a range that does cross
    // one.
    expect(monthly).toHaveLength(0);

    const tasksForFirstDay = await MilestoneTask.find({ milestoneId: daily[0]._id });
    expect(tasksForFirstDay).toHaveLength(8);
    expect(tasksForFirstDay.map((t) => t.title)).toEqual(
      expect.arrayContaining([
        'Morning Drink',
        'Breakfast',
        'Brunch',
        'Lunch',
        'Evening Snack',
        'Dinner',
        'Night Drink',
        'Supplements',
      ])
    );
  });

  test('is idempotent - a second call with the same plan does not duplicate the goal or milestones', async () => {
    const patient = await createPatient({
      healthProfile: { bmi: 22, weightIndex: 0, weight: 74, targetWeight: '64' },
    });
    const dietician = await createDietician();
    const plan = await makeActivePlan(patient, dietician, {
      startDate: new Date('2026-07-01T00:00:00.000Z'),
      endDate: new Date('2026-07-28T00:00:00.000Z'),
    });

    await seedGoalTimeline(plan);
    const milestoneCountBefore = await Milestone.countDocuments({});

    const secondResult = await seedGoalTimeline(plan);
    const milestoneCountAfter = await Milestone.countDocuments({});

    expect(await Goal.countDocuments({ patientId: patient._id })).toBe(1);
    expect(milestoneCountAfter).toBe(milestoneCountBefore);
    expect(secondResult._id.toString()).toBe((await Goal.findOne({ patientId: patient._id }))._id.toString());
  });

  test('a renewal (later endDate) extends the existing goal instead of re-seeding', async () => {
    const patient = await createPatient({
      healthProfile: { bmi: 22, weightIndex: 0, weight: 74, targetWeight: '64' },
    });
    const dietician = await createDietician();
    const firstPlan = await makeActivePlan(patient, dietician, {
      startDate: new Date('2026-07-01T00:00:00.000Z'),
      endDate: new Date('2026-07-28T00:00:00.000Z'),
    });
    const goal = await seedGoalTimeline(firstPlan);
    const dailyBefore = await Milestone.countDocuments({ goalId: goal._id, type: 'daily' });
    expect(dailyBefore).toBe(28);

    const renewalPlan = await makeActivePlan(patient, dietician, {
      startDate: new Date('2026-07-29T00:00:00.000Z'),
      endDate: new Date('2026-08-25T00:00:00.000Z'),
    });
    const extendedGoal = await seedGoalTimeline(renewalPlan);

    expect(extendedGoal._id.toString()).toBe(goal._id.toString());
    expect(await Goal.countDocuments({ patientId: patient._id })).toBe(1);
    expect(extendedGoal.endDate.toISOString().slice(0, 10)).toBe('2026-08-25');

    const dailyAfter = await Milestone.countDocuments({ goalId: goal._id, type: 'daily' });
    expect(dailyAfter).toBe(28 + 28); // original cycle + newly-extended cycle, no overlap re-seed

    // The extended range (07-29..08-25) crosses the July 31 month-end -
    // exactly one monthly node should now exist, dated there.
    const monthlyNodes = await Milestone.find({ goalId: goal._id, type: 'monthly' });
    expect(monthlyNodes).toHaveLength(1);
    expect(monthlyNodes[0].date.toISOString().slice(0, 10)).toBe('2026-07-31');

    // Only one end_goal node should exist, dated at the NEW endDate.
    const endGoalNodes = await Milestone.find({ goalId: goal._id, type: 'end_goal' });
    expect(endGoalNodes).toHaveLength(1);
    expect(endGoalNodes[0].date.toISOString().slice(0, 10)).toBe('2026-08-25');
  });

  test('returns null and creates nothing when the patient has no target weight set', async () => {
    const patient = await createPatient({
      healthProfile: { bmi: 22, weightIndex: 0, weight: 74 },
    });
    const dietician = await createDietician();
    const plan = await makeActivePlan(patient, dietician, {
      startDate: new Date('2026-07-01T00:00:00.000Z'),
      endDate: new Date('2026-07-28T00:00:00.000Z'),
    });

    const goal = await seedGoalTimeline(plan);

    expect(goal).toBeNull();
    expect(await Goal.countDocuments({ patientId: patient._id })).toBe(0);
  });

  test('falls back to DietPlanRequest.currentWeight when no Progress entry exists', async () => {
    const patient = await createPatient({
      healthProfile: { bmi: 22, weightIndex: 0, targetWeight: '64' }, // no healthProfile.weight
    });
    const dietician = await createDietician();
    const { DietPlanRequest } = require('../models');
    const request = await DietPlanRequest.create({
      patient: patient._id,
      dieticianId: dietician._id,
      startDateForDiet: new Date(),
      fullName: 'Test Patient',
      currentWeight: 80,
    });
    const startDate = new Date('2026-07-01T00:00:00.000Z');
    const endDate = new Date('2026-07-28T00:00:00.000Z');
    const plan = await DietPlan.create({
      patientId: patient._id,
      dieticianId: dietician._id,
      status: 'Active',
      startDate,
      endDate,
      weekSchedule: [{ week: 1, startDate, endDate }],
      request: request._id,
    });
    await plan.populate('request');

    const goal = await seedGoalTimeline(plan);

    expect(goal.startValue).toBe(80);
  });
});
