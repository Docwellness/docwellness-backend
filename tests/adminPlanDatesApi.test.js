/**
 * Admin plan dates API (openspec admin-plan-dates-timeline).
 * Real Express app + real in-memory MongoDB; only the admin identity is faked,
 * the permission guard is the real one so a role without users:view is refused.
 */
const { connectTestDb, disconnectTestDb, clearTestDb } = require('./helpers/testDb');
const { DEFAULT_ROLES } = require('../utils/adminPermissions');

jest.mock('../middlewares/adminAuth', () => ({
  ...jest.requireActual('../middlewares/adminAuth'),
  adminAuth: (req, res, next) => {
    const { DEFAULT_ROLES: roles } = require('../utils/adminPermissions');
    const role = roles.find((r) => r.name === (req.headers['x-test-role'] || 'super_admin'));
    req.admin = { email: 'docwellness.fit@gmail.com', user: { _id: '000000000000000000000009' }, permissions: role.permissions };
    next();
  },
}));

let request, app;
let createPatient, createDietician, createDietPlanRequest, createActiveDietPlan;
let User, DietPlan, DietPlanRequest, Goal, AdminAuditLog;
const DAY = 86400_000;

beforeAll(async () => {
  await connectTestDb();
  request = require('supertest');
  app = require('../config/createApp')();
  ({ createPatient, createDietician, createDietPlanRequest, createActiveDietPlan } = require('./helpers/factories'));
  ({ User, DietPlan, DietPlanRequest, Goal } = require('../models'));
  AdminAuditLog = require('../models/AdminAuditLog');
});
afterEach(async () => {
  await clearTestDb();
});
afterAll(async () => {
  await disconnectTestDb();
});

const get = (id, role) => {
  const r = request(app).get(`/api/admin/users/${id}/plan-dates`);
  return role ? r.set('x-test-role', role) : r;
};

const ENDS = new Date('2026-10-26T06:00:00.000Z');
const day = (s) => new Date(`${s}T00:00:00.000Z`);

async function seedFullPatient() {
  const patient = await createPatient({ email: 'secret.person@example.test' });
  await User.updateOne(
    { _id: patient._id },
    {
      $set: {
        'profile.fullName': 'Private Person',
        'profile.whatsappNumber': '9822012345',
        'healthProfile.weight': 83.7,
      },
    }
  );
  const dietician = await createDietician();
  const dietRequest = await createDietPlanRequest(patient, dietician, {
    subscriptionStartDate: day('2026-10-04'),
    subscriptionExpiresAt: ENDS,
  });
  await createActiveDietPlan(patient, dietician, {
    request: dietRequest._id,
    cycleNumber: 1,
    weekSchedule: [
      { week: 1, startDate: day('2026-10-04'), endDate: day('2026-10-11') },
      { week: 2, startDate: day('2026-10-11'), endDate: day('2026-10-18') },
    ],
    pauses: [{ startDate: day('2026-10-14'), resumeDate: day('2026-10-19') }],
  });
  await Goal.create({
    patientId: patient._id,
    title: 'Fit into the blue wedding suit',
    targetValue: 64.25,
    startDate: day('2026-10-04'),
    endDate: day('2026-10-18'),
  });
  await AdminAuditLog.create({
    action: 'user.extend_subscription',
    outcome: 'success',
    targetType: 'user',
    targetId: String(patient._id),
    actorEmail: 'admin@example.com',
    before: { subscriptionExpiresAt: day('2026-10-12') },
    after: { subscriptionExpiresAt: ENDS },
    reason: 'Missed two weeks',
    requestId: 'req-ext-1',
  });
  return patient;
}

describe('GET /api/admin/users/:id/plan-dates', () => {
  it('answers 404 for an unknown id and for a dietician, and 400 for a malformed id like the detail route', async () => {
    const dietician = await createDietician();
    expect((await get('000000000000000000000abc')).status).toBe(404);
    expect((await get(dietician._id)).status).toBe(404);
    expect((await get(dietician._id)).body).toEqual({ success: false, message: 'Patient not found' });
    expect((await get('not-an-id')).status).toBe(400);
  });

  it('returns the documented shape for a patient with a request, plan, pause, goal and extension', async () => {
    const patient = await seedFullPatient();
    const r = await get(patient._id);
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    const data = r.body.data;
    expect(data.generatedFor).toBe(String(patient._id));
    expect(data.appliedPauseDays).toBe(5);
    expect(data.requests).toHaveLength(1);
    expect(data.requests[0]).toMatchObject({
      isLatest: true,
      expiresDay: '2026-10-26',
      pauseDaysIncluded: 5,
      expiresBeforePausesDay: '2026-10-21',
    });
    const [cycle] = data.requests[0].cycles;
    expect(cycle.weeks[1]).toMatchObject({ storedEnd: '2026-10-18', shownEnd: '2026-10-23' });
    expect(cycle.pauses[0]).toMatchObject({ startDay: '2026-10-14', resumeDay: '2026-10-19', lengthDays: 5, setBy: null });
    expect(data.goals[0]).toMatchObject({ status: 'active', storedEnd: '2026-10-18', shownEnd: '2026-10-23' });
    expect(data.summary.gapDays).toEqual({ lastWeekShown: 3, goalShown: 3 });
    expect(data.extensions).toEqual([
      expect.objectContaining({ actorEmail: 'admin@example.com', before: '2026-10-12', after: '2026-10-26', applied: true }),
    ]);
  });

  it('hides extension actor and reason from a role with users:view but not audit:view', async () => {
    const patient = await seedFullPatient();
    const viewer = await get(patient._id, 'viewer');
    expect(viewer.status).toBe(200);
    expect(viewer.body.data.extensions).toEqual([
      { at: expect.any(String), actorEmail: null, before: '2026-10-12', after: '2026-10-26', reason: null, applied: true, restricted: true },
    ]);
    expect(JSON.stringify(viewer.body)).not.toMatch(/admin@example\.com|Missed two weeks/);

    const superAdmin = await get(patient._id, 'super_admin');
    expect(superAdmin.body.data.extensions[0]).toMatchObject({ actorEmail: 'admin@example.com', reason: 'Missed two weeks', restricted: false });
  });

  it('contains no personal or clinical value of the patient', async () => {
    const patient = await seedFullPatient();
    const text = JSON.stringify((await get(patient._id)).body);
    for (const secret of ['9822012345', 'secret.person@example.test', 'Private Person', '83.7', 'blue wedding suit', '64.25']) {
      expect(text).not.toContain(secret);
    }
  });

  it('is read-only: documents, updatedAt values and the audit log are identical after two calls', async () => {
    const patient = await seedFullPatient();
    const snapshot = async () => ({
      plans: await DietPlan.countDocuments(),
      requests: await DietPlanRequest.countDocuments(),
      goals: await Goal.countDocuments(),
      users: await User.countDocuments(),
      audit: await AdminAuditLog.countDocuments(),
      updated: [
        ...(await DietPlan.find().select('updatedAt').lean()),
        ...(await DietPlanRequest.find().select('updatedAt').lean()),
        ...(await Goal.find().select('updatedAt').lean()),
        ...(await User.find().select('updatedAt').lean()),
      ].map((doc) => String(doc.updatedAt)),
    });
    const before = await snapshot();
    expect((await get(patient._id)).status).toBe(200);
    expect((await get(patient._id)).status).toBe(200);
    expect(await snapshot()).toEqual(before);
  });

  it('returns empty collections with 200 for a patient with nothing', async () => {
    const patient = await createPatient();
    const r = await get(patient._id);
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({
      appliedPauseDays: 0,
      requests: [],
      unlinkedCycles: [],
      goals: [],
      extensions: [],
    });
    expect(r.body.data.summary.membershipEndDay).toBeNull();
  });

  it('does not fail on a plan with a week that has no endDate', async () => {
    const patient = await createPatient();
    const dietician = await createDietician();
    const dietRequest = await createDietPlanRequest(patient, dietician, { subscriptionExpiresAt: ENDS });
    await DietPlan.collection.insertOne({
      patientId: patient._id,
      dieticianId: dietician._id,
      request: dietRequest._id,
      status: 'Active',
      cycleNumber: 1,
      weekSchedule: [{ week: 1, startDate: day('2026-10-04') }],
      pauses: [],
    });
    const r = await get(patient._id);
    expect(r.status).toBe(200);
    expect(r.body.data.requests[0].cycles[0].weeks[0]).toMatchObject({ storedEnd: null, shownEnd: null });
  });

  it('refuses a role without users:view exactly as the detail route does', async () => {
    const patient = await createPatient();
    const noUsersView = DEFAULT_ROLES.find((r) => !(r.permissions.users || []).includes('view'));
    const detail = await request(app).get(`/api/admin/users/${patient._id}`).set('x-test-role', noUsersView.name);
    const dates = await get(patient._id, noUsersView.name);
    expect(detail.status).toBe(403);
    expect(dates.status).toBe(403);
    expect(dates.body).toEqual(detail.body);
  });
});
