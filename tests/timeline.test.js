const { connectTestDb, disconnectTestDb, clearTestDb } = require('./helpers/testDb');

jest.mock('../utils/supabaseAuth');
const { registerTestToken, clearTestTokens } = require('../utils/supabaseAuth');

let request, app;
let createPatient, createDietician;
let Goal, Milestone, MilestoneTask, CheckIn, Notification, Nudge;
let seedGoalTimeline;

beforeAll(async () => {
  await connectTestDb();
  request = require('supertest');
  app = require('../config/createApp')();
  ({ createPatient, createDietician } = require('./helpers/factories'));
  ({ Goal, Milestone, MilestoneTask, CheckIn, Notification, Nudge } = require('../models'));
  ({ seedGoalTimeline } = require('../utils/seedGoalTimeline'));
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
  const startDate = new Date('2026-07-01T00:00:00.000Z');
  const endDate = new Date('2026-07-28T00:00:00.000Z');
  const plan = await DietPlan.create({
    patientId: patient._id,
    dieticianId: dietician._id,
    status: 'Active',
    startDate,
    endDate,
    // weekSchedule (not the top-level startDate/endDate) is what
    // seedGoalTimeline actually resolves dates from - see
    // utils/trackingBuckets.js's resolvePlanStartDate/EndDate.
    weekSchedule: [{ week: 1, startDate, endDate }],
  });
  const goal = await seedGoalTimeline(plan);
  return { patient, goal };
}

describe('GET /api/patient/timeline', () => {
  test('401s without a token', async () => {
    const res = await request(app).get('/api/patient/timeline');
    expect(res.status).toBe(401);
  });

  test("returns null goal/stats for a patient with no active goal", async () => {
    const patient = await createPatient();
    registerTestToken('patient-token', patient._id);

    const res = await request(app)
      .get('/api/patient/timeline')
      .set('Authorization', 'Bearer patient-token');

    expect(res.status).toBe(200);
    expect(res.body.data.goal).toBeNull();
    expect(res.body.data.milestones).toEqual([]);
  });

  test('returns goal + milestones + tasks for a seeded patient', async () => {
    const dietician = await createDietician();
    const { patient } = await seedPatientWithGoal(dietician);
    registerTestToken('patient-token', patient._id);

    const res = await request(app)
      .get('/api/patient/timeline?from=-2&to=2')
      .set('Authorization', 'Bearer patient-token');

    expect(res.status).toBe(200);
    expect(res.body.data.goal.targetValue).toBe(64);
    expect(res.body.data.milestones.length).toBeGreaterThan(0);
    const daily = res.body.data.milestones.find((m) => m.type === 'daily');
    expect(daily.tasks.length).toBe(4);
    expect(daily.tasks[0]).toHaveProperty('done');
  });
});

describe('GET /api/patient/timeline/days/:date/logs', () => {
  test("returns this patient's own logged meals and weight for the date", async () => {
    const dietician = await createDietician();
    const { patient } = await seedPatientWithGoal(dietician);
    registerTestToken('patient-token', patient._id);

    const { MealLog, Progress } = require('../models');
    const date = new Date('2026-07-28T00:00:00.000Z');
    await MealLog.create({
      patientId: patient._id,
      date,
      meals: [{ mealType: 'Breakfast', servingTime: 'Breakfast', caloriesConsumed: 350 }],
    });
    await Progress.create({ patientId: patient._id, date, weight: 73 });

    const res = await request(app)
      .get('/api/patient/timeline/days/2026-07-28/logs')
      .set('Authorization', 'Bearer patient-token');

    expect(res.status).toBe(200);
    expect(res.body.data.meals).toHaveLength(1);
    expect(res.body.data.meals[0].mealType).toBe('Breakfast');
    expect(res.body.data.progress).toHaveLength(1);
    expect(res.body.data.progress[0].weight).toBe(73);
  });

  test('400s on an invalid date', async () => {
    const patient = await createPatient();
    registerTestToken('patient-token', patient._id);

    const res = await request(app)
      .get('/api/patient/timeline/days/not-a-date/logs')
      .set('Authorization', 'Bearer patient-token');

    expect(res.status).toBe(400);
  });
});

describe('POST /api/patient/check-ins + DELETE /check-ins/today/:taskId', () => {
  test('checks in a task, reflects done:true afterward, then uncheck reverts it', async () => {
    const dietician = await createDietician();
    const { patient, goal } = await seedPatientWithGoal(dietician);
    registerTestToken('patient-token', patient._id);

    const todayMilestone = await Milestone.findOne({
      goalId: goal._id,
      type: 'daily',
      date: { $lte: new Date() },
    }).sort({ date: -1 });
    const task = await MilestoneTask.findOne({ milestoneId: todayMilestone._id });

    const checkInRes = await request(app)
      .post('/api/patient/check-ins')
      .set('Authorization', 'Bearer patient-token')
      .send({ taskId: task._id.toString(), milestoneId: todayMilestone._id.toString() });

    expect(checkInRes.status).toBe(201);
    expect(await CheckIn.countDocuments({ taskId: task._id })).toBe(1);

    // Re-posting the same check-in today should not error or duplicate.
    const secondRes = await request(app)
      .post('/api/patient/check-ins')
      .set('Authorization', 'Bearer patient-token')
      .send({ taskId: task._id.toString(), milestoneId: todayMilestone._id.toString() });
    expect(secondRes.status).toBe(201);
    expect(await CheckIn.countDocuments({ taskId: task._id })).toBe(1);

    const deleteRes = await request(app)
      .delete(`/api/patient/check-ins/today/${task._id}`)
      .set('Authorization', 'Bearer patient-token');
    expect(deleteRes.status).toBe(200);
    expect(await CheckIn.countDocuments({ taskId: task._id })).toBe(0);
  });

  test("403s when trying to check in on another patient's task", async () => {
    const dietician = await createDietician();
    const { goal } = await seedPatientWithGoal(dietician);
    const otherPatient = await createPatient();
    registerTestToken('other-token', otherPatient._id);

    const someMilestone = await Milestone.findOne({ goalId: goal._id, type: 'daily' });
    const someTask = await MilestoneTask.findOne({ milestoneId: someMilestone._id });

    const res = await request(app)
      .post('/api/patient/check-ins')
      .set('Authorization', 'Bearer other-token')
      .send({ taskId: someTask._id.toString(), milestoneId: someMilestone._id.toString() });

    expect(res.status).toBe(403);
  });
});

describe('GET /api/dietician/patients/:patientId/timeline', () => {
  test("403s when patient isn't this dietician's own", async () => {
    const dietician = await createDietician();
    const otherDietician = await createDietician();
    const { patient } = await seedPatientWithGoal(dietician);
    registerTestToken('other-dietician-token', otherDietician._id);

    const res = await request(app)
      .get(`/api/dietician/patients/${patient._id}/timeline`)
      .set('Authorization', 'Bearer other-dietician-token');

    expect(res.status).toBe(404);
  });

  test('returns the timeline for the assigned dietician', async () => {
    const dietician = await createDietician();
    const { patient } = await seedPatientWithGoal(dietician);
    registerTestToken('dietician-token', dietician._id);

    const res = await request(app)
      .get(`/api/dietician/patients/${patient._id}/timeline`)
      .set('Authorization', 'Bearer dietician-token');

    expect(res.status).toBe(200);
    expect(res.body.data.goal.targetValue).toBe(64);
  });
});

describe('POST /api/dietician/nudges', () => {
  test('creates a Nudge + Notification for the assigned patient', async () => {
    const dietician = await createDietician();
    const { patient } = await seedPatientWithGoal(dietician);
    registerTestToken('dietician-token', dietician._id);

    const res = await request(app)
      .post('/api/dietician/nudges')
      .set('Authorization', 'Bearer dietician-token')
      .send({ userId: patient._id.toString(), message: "Time to log today's meals" });

    expect(res.status).toBe(201);
    expect(await Nudge.countDocuments({ patientId: patient._id })).toBe(1);
    const notification = await Notification.findOne({ userId: patient._id });
    expect(notification.type).toBe('milestone');
    expect(notification.message).toBe("Time to log today's meals");
  });
});

describe('POST /api/dietician/milestones + PUT /:id', () => {
  test('adds a custom milestone with tasks, then edits it', async () => {
    const dietician = await createDietician();
    const { patient, goal } = await seedPatientWithGoal(dietician);
    registerTestToken('dietician-token', dietician._id);

    const createRes = await request(app)
      .post('/api/dietician/milestones')
      .set('Authorization', 'Bearer dietician-token')
      .send({
        userId: patient._id.toString(),
        type: 'weekly',
        date: '2026-08-03',
        title: 'Week 32',
        subtitle: 'Focus: protein',
        tasks: [{ title: 'Log 6/7 days', metric: '6 days', icon: 'restaurant' }],
      });

    expect(createRes.status).toBe(201);
    const milestoneId = createRes.body.data.milestone._id;
    expect(await MilestoneTask.countDocuments({ milestoneId })).toBe(1);

    const updateRes = await request(app)
      .put(`/api/dietician/milestones/${milestoneId}`)
      .set('Authorization', 'Bearer dietician-token')
      .send({ title: 'Week 32 (updated)' });

    expect(updateRes.status).toBe(200);
    expect(updateRes.body.data.milestone.title).toBe('Week 32 (updated)');

    const finalGoal = await Goal.findById(goal._id);
    expect(finalGoal).toBeTruthy();
  });
});
