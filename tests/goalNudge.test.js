const { connectTestDb, disconnectTestDb, clearTestDb } = require('./helpers/testDb');

jest.mock('../utils/supabaseAuth');
const { clearTestTokens } = require('../utils/supabaseAuth');

let createPatient, createDietician;
let Goal, Notification, Progress;
let seedGoalTimeline;
let runGoalNudgeSweep;

beforeAll(async () => {
  await connectTestDb();
  ({ createPatient, createDietician } = require('./helpers/factories'));
  ({ Goal, Notification, Progress } = require('../models'));
  ({ seedGoalTimeline } = require('../utils/seedGoalTimeline'));
  ({ runGoalNudgeSweep } = require('../controllers/internal/goalNudgeController'));
});

afterEach(async () => {
  clearTestTokens();
  await clearTestDb();
});

afterAll(async () => {
  await disconnectTestDb();
});

async function seedPatientWithGoal(dietician) {
  const patient = await createPatient({
    healthProfile: { bmi: 22, weightIndex: 0, weight: 74, targetWeight: '64' },
  });
  const { DietPlan } = require('../models');
  const startDate = new Date('2026-06-01T00:00:00.000Z');
  const endDate = new Date('2026-06-28T00:00:00.000Z');
  const plan = await DietPlan.create({
    patientId: patient._id,
    dieticianId: dietician._id,
    status: 'Active',
    startDate,
    endDate,
    weekSchedule: [{ week: 1, startDate, endDate }],
  });
  const goal = await seedGoalTimeline(plan);
  return { patient, goal };
}

describe('runGoalNudgeSweep', () => {
  test('nudges a patient whose goal ended without reaching the target', async () => {
    const dietician = await createDietician();
    const { patient, goal } = await seedPatientWithGoal(dietician);
    // goal.endDate (2026-06-28) is already in the past relative to today's
    // fixed test date (2026-07-29 per system context) - startValue 74,
    // targetValue 64, no Progress logged, so currentValue falls back to
    // goal.startValue - progress 0, well short of the target.

    const result = await runGoalNudgeSweep();

    expect(result.checked).toBe(1);
    expect(result.created).toBe(1);

    const notification = await Notification.findOne({ userId: patient._id });
    expect(notification).toBeTruthy();
    expect(notification.type).toBe('milestone');
    expect(notification.message).toMatch(/continue|rebook/i);

    const updatedGoal = await Goal.findById(goal._id);
    expect(updatedGoal.nudgeSentAt).toBeTruthy();
  });

  test('does not re-nudge a goal that was already nudged', async () => {
    const dietician = await createDietician();
    await seedPatientWithGoal(dietician);

    await runGoalNudgeSweep();
    const second = await runGoalNudgeSweep();

    expect(second.checked).toBe(0);
    expect(second.created).toBe(0);
  });

  test('skips (and stamps) a goal whose latest Progress already reached the target', async () => {
    const dietician = await createDietician();
    const { patient, goal } = await seedPatientWithGoal(dietician);
    await Progress.create({ patientId: patient._id, date: new Date('2026-06-27'), weight: 64 });

    const result = await runGoalNudgeSweep();

    expect(result.checked).toBe(1);
    expect(result.created).toBe(0);
    const updatedGoal = await Goal.findById(goal._id);
    expect(updatedGoal.nudgeSentAt).toBeTruthy();
    const notification = await Notification.findOne({ userId: patient._id });
    expect(notification).toBeNull();
  });

  test('does not touch a goal whose endDate is still in the future', async () => {
    const dietician = await createDietician();
    const patient = await createPatient({
      healthProfile: { bmi: 22, weightIndex: 0, weight: 74, targetWeight: '64' },
    });
    await Goal.create({
      patientId: patient._id,
      dieticianId: dietician._id,
      title: 'Reach 64 kg',
      startValue: 74,
      currentValue: 74,
      targetValue: 64,
      startDate: new Date(),
      endDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      status: 'active',
    });

    const result = await runGoalNudgeSweep();

    expect(result.checked).toBe(0);
    expect(result.created).toBe(0);
  });
});
