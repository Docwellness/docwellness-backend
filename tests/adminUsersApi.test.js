/**
 * Admin users API (openspec add-admin-panel: admin-user-management).
 * Real Express app + real in-memory MongoDB; only the admin identity gate is faked.
 */
const { connectTestDb, disconnectTestDb, clearTestDb } = require('./helpers/testDb');
const { maskPhone, maskEmail, maskDob } = require('../utils/piiMask');

jest.mock('../middlewares/adminAuth', () => ({
  adminAuth: (req, res, next) => {
    req.admin = { email: 'docwellness.fit@gmail.com', user: { _id: '000000000000000000000009' }, permissions: {} };
    next();
  },
  requirePermission: () => (req, res, next) => next(),
}));

let request, app;
let createPatient, createDietician, createDietPlanRequest;
let User, DietPlanRequest, DietPlan, ManualPaymentProof, AdminAuditLog;
const DAY = 86400_000;

beforeAll(async () => {
  await connectTestDb();
  request = require('supertest');
  app = require('../config/createApp')();
  ({ createPatient, createDietician, createDietPlanRequest } = require('./helpers/factories'));
  ({ User, DietPlanRequest, DietPlan, ManualPaymentProof } = require('../models'));
  AdminAuditLog = require('../models/AdminAuditLog');
});
afterEach(async () => {
  await clearTestDb();
});
afterAll(async () => {
  await disconnectTestDb();
});

const get = (p) => request(app).get(`/api/admin${p}`);
const post = (p, body) => request(app).post(`/api/admin${p}`).send(body || {});

async function seedPatient({ name = 'Asha Patil', phone = '9822012345', email, expiresInDays } = {}) {
  const patient = await createPatient(email ? { email } : {});
  await User.updateOne(
    { _id: patient._id },
    {
      $set: {
        'profile.fullName': name,
        'profile.whatsappNumber': phone,
        'profile.dateOfBirth': new Date('1991-04-17T00:00:00Z'),
        ...(expiresInDays !== undefined ? { 'status.subscriptionExpiresAt': new Date(Date.now() + expiresInDays * DAY) } : {}),
      },
    }
  );
  return patient;
}

describe('piiMask', () => {
  it('masks phone, email and date of birth', () => {
    expect(maskPhone('+91 98220 12345')).toBe('********45');
    expect(maskPhone('12')).toBe('**');
    expect(maskPhone('')).toBe('');
    expect(maskEmail('asha.patil@gmail.com')).toBe('a******@gmail.com');
    expect(maskEmail('ab@x.co')).toBe('a**@x.co');
    expect(maskEmail('not-an-email')).toBe('***');
    expect(maskDob('1991-04-17T00:00:00Z')).toBe('**/**/1991');
    expect(maskDob(null)).toBe('');
  });
});

describe('directory', () => {
  it('never returns an unmasked phone or email in a list', async () => {
    await seedPatient({ email: 'asha@example.com' });
    const r = await get('/users');
    expect(r.status).toBe(200);
    const row = r.body.data.items[0];
    expect(row.phone).toBe('********45');
    expect(row.email).toBe('a***@example.com');
    expect(JSON.stringify(r.body)).not.toContain('9822012345');
    expect(JSON.stringify(r.body)).not.toContain('asha@example.com');
  });

  it('searches by name, a phone fragment or email, and only returns patients', async () => {
    await seedPatient({ name: 'Asha Patil', phone: '9822012345' });
    await seedPatient({ name: 'Rohan Deshmukh', phone: '9011155555' });
    const dietician = await createDietician();
    await User.updateOne({ _id: dietician._id }, { $set: { 'profile.fullName': 'Asha Dietician' } });

    expect((await get('/users?q=asha')).body.data.items.map((i) => i.name)).toEqual(['Asha Patil']);
    expect((await get('/users?q=55555')).body.data.items.map((i) => i.name)).toEqual(['Rohan Deshmukh']);
    expect((await get('/users')).body.data.total).toBe(2);
  });

  it('filters by subscription state and by account status', async () => {
    await seedPatient({ name: 'Expiring Soon', expiresInDays: 3 });
    await seedPatient({ name: 'Running Long', expiresInDays: 60 });
    await seedPatient({ name: 'Lapsed', expiresInDays: -5 });
    await seedPatient({ name: 'Never Paid' });
    const names = async (qs) => (await get(`/users?${qs}`)).body.data.items.map((i) => i.name).sort();

    expect(await names('subscription=expiring')).toEqual(['Expiring Soon']);
    expect(await names('subscription=active')).toEqual(['Running Long']);
    expect(await names('subscription=expired')).toEqual(['Lapsed']);
    expect(await names('subscription=never')).toEqual(['Never Paid']);

    const lapsed = (await User.findOne({ 'profile.fullName': 'Lapsed' }))._id;
    await post(`/users/${lapsed}/suspend`, { reason: 'Abusive messages' });
    expect(await names('account=suspended')).toEqual(['Lapsed']);
    expect(await names('account=active')).toHaveLength(3);
  });
});

describe('detail and reveal', () => {
  it('shows a masked summary with no clinical content', async () => {
    const patient = await seedPatient();
    const r = await get(`/users/${patient._id}`);
    expect(r.status).toBe(200);
    expect(r.body.data.phone).toBe('********45');
    expect(Object.keys(r.body.data)).not.toEqual(expect.arrayContaining(['mealLogs', 'labReports', 'chats', 'notes']));
    expect((await get('/users/000000000000000000000abc')).status).toBe(404);
    expect((await get('/users/not-an-id')).status).toBe(400); // malformed ids are refused by the shared id check
  });

  it('reveal returns the value and records exactly what was accessed', async () => {
    const patient = await seedPatient();
    const r = await post(`/users/${patient._id}/reveal`, { field: 'phone' });
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual({ field: 'phone', value: '9822012345' });
    const dob = await post(`/users/${patient._id}/reveal`, { field: 'dob' });
    expect(dob.body.data.value).toBe('1991-04-17');

    const logs = await AdminAuditLog.find({ action: 'user.reveal' }).sort({ createdAt: 1 }).lean();
    expect(logs.map((l) => l.meta.field)).toEqual(['phone', 'dob']);
    expect(logs[0].targetId).toBe(String(patient._id));
    expect((await post(`/users/${patient._id}/reveal`, { field: 'password' })).status).toBe(400);
  });
});

describe('suspend and reactivate', () => {
  it('requires a reason, flips isActive, and rejects repeats', async () => {
    const patient = await seedPatient();
    expect((await post(`/users/${patient._id}/suspend`, {})).status).toBe(400);
    expect((await User.findById(patient._id)).isActive).not.toBe(false);

    expect((await post(`/users/${patient._id}/suspend`, { reason: 'Chargeback' })).status).toBe(200);
    expect((await User.findById(patient._id)).isActive).toBe(false);
    expect((await post(`/users/${patient._id}/suspend`, { reason: 'again' })).status).toBe(409);

    expect((await post(`/users/${patient._id}/reactivate`, { reason: 'Resolved' })).status).toBe(200);
    expect((await User.findById(patient._id)).isActive).toBe(true);
    const logs = await AdminAuditLog.find({ targetId: String(patient._id) }).sort({ createdAt: 1 }).lean();
    expect(logs.map((l) => l.action)).toEqual(expect.arrayContaining(['user.suspend', 'user.reactivate']));
    expect(logs.find((l) => l.action === 'user.suspend').reason).toBe('Chargeback');
  });
});

describe('extend subscription', () => {
  async function withMembership(expiresInDays) {
    const dietician = await createDietician();
    const patient = await seedPatient({ expiresInDays });
    const dpr = await createDietPlanRequest(patient, dietician, {
      status: 'Paid',
      hasActivePlan: true,
      subscriptionExpiresAt: new Date(Date.now() + expiresInDays * DAY),
    });
    return { patient, dpr };
  }

  it('extends an active membership from its current end date', async () => {
    const { patient, dpr } = await withMembership(10);
    const before = (await DietPlanRequest.findById(dpr._id)).subscriptionExpiresAt.getTime();
    const r = await post(`/users/${patient._id}/extend-subscription`, { days: 14, reason: 'Goodwill after downtime' });
    expect(r.status).toBe(200);
    const after = (await DietPlanRequest.findById(dpr._id)).subscriptionExpiresAt.getTime();
    expect(after - before).toBe(14 * DAY);
    expect((await User.findById(patient._id)).status.subscriptionExpiresAt.getTime()).toBe(after);

    const audit = await AdminAuditLog.findOne({ action: 'user.extend_subscription' }).lean();
    expect(audit.reason).toBe('Goodwill after downtime');
    expect(new Date(audit.after.subscriptionExpiresAt).getTime()).toBe(after);
  });

  it('counts from today when the membership has already ended', async () => {
    const { patient, dpr } = await withMembership(-20);
    const r = await post(`/users/${patient._id}/extend-subscription`, { days: 7, reason: 'Late payment accepted' });
    expect(r.status).toBe(200);
    const end = (await DietPlanRequest.findById(dpr._id)).subscriptionExpiresAt.getTime();
    expect(Math.abs(end - (Date.now() + 7 * DAY))).toBeLessThan(60_000);
  });

  it('accepts an end date, and refuses missing reasons, bad input and past dates', async () => {
    const { patient } = await withMembership(5);
    const until = new Date(Date.now() + 40 * DAY).toISOString();
    expect((await post(`/users/${patient._id}/extend-subscription`, { until, reason: 'Pro-rata' })).status).toBe(200);

    expect((await post(`/users/${patient._id}/extend-subscription`, { days: 7 })).status).toBe(400);
    expect((await post(`/users/${patient._id}/extend-subscription`, { reason: 'x' })).status).toBe(400);
    expect((await post(`/users/${patient._id}/extend-subscription`, { days: 0, reason: 'x' })).status).toBe(400);
    expect((await post(`/users/${patient._id}/extend-subscription`, { days: 999, reason: 'x' })).status).toBe(400);
    expect((await post(`/users/${patient._id}/extend-subscription`, { until: new Date(Date.now() - DAY).toISOString(), reason: 'x' })).status).toBe(400);
  });

  it('refuses a patient with no membership', async () => {
    const patient = await seedPatient();
    const r = await post(`/users/${patient._id}/extend-subscription`, { days: 7, reason: 'x' });
    expect(r.status).toBe(409);
  });
});

describe('journey stage', () => {
  let dietician;
  async function patientAt(name, requestOver, { draftPlan = false, proof = null } = {}) {
    const patient = await seedPatient({ name });
    const dpr = await createDietPlanRequest(patient, dietician, { membershipPlan: '3 months', membershipAmount: 9000, ...requestOver });
    if (draftPlan) await DietPlan.create({ patientId: patient._id, dieticianId: dietician._id, status: 'Draft', activationDate: new Date() });
    if (proof) await ManualPaymentProof.create({ request: dpr._id, patient: patient._id, amountReceived: 9000, amountPending: 0, status: proof });
    return { patient, dpr };
  }

  beforeEach(async () => {
    dietician = await createDietician();
  });

  async function seedAll() {
    const ids = {};
    ids.none = (await seedPatient({ name: 'P None' }))._id;
    ids.requested = (await patientAt('P Requested', { status: 'Unpaid' })).patient._id;
    ids.diet = (await patientAt('P Diet', { status: 'Unpaid' }, { draftPlan: true })).patient._id;
    ids.payReq = (await patientAt('P PayReq', { status: 'PaymentRequested' }, { draftPlan: true })).patient._id;
    ids.paySub = (await patientAt('P PaySub', { status: 'PaymentSubmitted' }, { draftPlan: true, proof: 'Submitted' })).patient._id;
    ids.active = (
      await patientAt('P Active', { status: 'Paid', hasActivePlan: true, subscriptionStartDate: new Date(), subscriptionExpiresAt: new Date(Date.now() + 30 * DAY) })
    ).patient._id;
    return ids;
  }

  it('shows the real stage and the chosen plan for each patient, not "never subscribed"', async () => {
    await seedAll();
    const items = (await get('/users?limit=50')).body.data.items;
    const by = Object.fromEntries(items.map((i) => [i.name, i]));
    expect(by['P None'].stage).toBe('none');
    expect(by['P Requested']).toMatchObject({ stage: 'requested', plan: { name: '3 months', amount: 9000 } });
    expect(by['P Diet'].stage).toBe('diet_in_progress');
    expect(by['P PayReq'].stage).toBe('payment_requested');
    expect(by['P PaySub'].stage).toBe('payment_submitted');
    expect(by['P Active'].stage).toBe('active');
  });

  it('filters by stage', async () => {
    await seedAll();
    const names = async (stage) => (await get(`/users?stage=${stage}`)).body.data.items.map((i) => i.name).sort();
    expect(await names('requested')).toEqual(['P Requested']);
    expect(await names('diet_in_progress')).toEqual(['P Diet']);
    expect(await names('payment_requested')).toEqual(['P PayReq']);
    expect(await names('payment_submitted')).toEqual(['P PaySub']);
    expect(await names('active')).toEqual(['P Active']);
    expect(await names('none')).toEqual(['P None']);
    expect((await get('/users?stage=nonsense')).body.data.total).toBe(6); // unknown stage is ignored
  });

  it('detail returns the journey timeline and the plan chosen before any payment', async () => {
    const ids = await seedAll();
    const early = (await get(`/users/${ids.requested}`)).body.data;
    expect(early.stage).toBe('requested');
    expect(early.plan).toMatchObject({ name: '3 months', amount: 9000, status: 'Unpaid', hasActivePlan: false });
    expect(early.journey.map((s) => [s.key, s.done])).toEqual([
      ['requested', true],
      ['diet_created', false],
      ['diet_ready', false],
      ['payment_requested', false],
      ['payment_submitted', false],
      ['payment_confirmed', false],
      ['diet_started', false],
    ]);
    expect(early.journey[0].detail).toBe('Chose 3 months (9000)');

    const waiting = (await get(`/users/${ids.paySub}`)).body.data;
    expect(waiting.stage).toBe('payment_submitted');
    expect(waiting.journey.find((s) => s.key === 'diet_created').done).toBe(true);
    expect(waiting.journey.find((s) => s.key === 'payment_submitted').done).toBe(true);
    expect(waiting.journey.find((s) => s.key === 'payment_confirmed').done).toBe(false);
    expect(waiting.journey.find((s) => s.key === 'diet_started').done).toBe(false);

    const running = (await get(`/users/${ids.active}`)).body.data;
    expect(running.stage).toBe('active');
    expect(running.journey.find((s) => s.key === 'diet_started').done).toBe(true);
    expect(running.journey.find((s) => s.key === 'payment_confirmed').done).toBe(true); // request is Paid
  });
});

describe('owning dietician', () => {
  it('shows the dietician on each row and detail, and filters by dietician', async () => {
    const a = await createDietician();
    const b = await createDietician();
    await User.updateOne({ _id: a._id }, { $set: { 'profile.fullName': 'Dr Asha' } });
    const p1 = await seedPatient({ name: 'Mine 1' });
    const p2 = await seedPatient({ name: 'Mine 2' });
    const p3 = await seedPatient({ name: 'Theirs' });
    await seedPatient({ name: 'No dietician' });
    await createDietPlanRequest(p1, a, {});
    await createDietPlanRequest(p2, a, {});
    await createDietPlanRequest(p3, b, {});

    const rows = (await get('/users?limit=50')).body.data.items;
    const by = Object.fromEntries(rows.map((r) => [r.name, r]));
    expect(by['Mine 1']).toMatchObject({ dieticianName: 'Dr Asha', dieticianId: String(a._id) });
    expect(by['No dietician'].dieticianName).toBe('');

    const mine = (await get(`/users?dietician=${a._id}`)).body.data.items.map((r) => r.name).sort();
    expect(mine).toEqual(['Mine 1', 'Mine 2']);
    expect((await get('/users?dietician=not-an-id')).body.data.total).toBe(4); // ignored
    expect((await get(`/users/${p1._id}`)).body.data).toMatchObject({ dieticianName: 'Dr Asha', dieticianId: String(a._id) });
  });
});
