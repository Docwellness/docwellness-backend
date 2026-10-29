const mongoose = require('mongoose');
const { connectTestDb, disconnectTestDb, clearTestDb } = require('./helpers/testDb');
const { seedPatientData } = require('./helpers/seedPatientData');

jest.mock('../utils/supabaseAuth');

let factories;
let models;
let buildPatientExport;
let CATEGORY_KEYS;

beforeAll(async () => {
  await connectTestDb();
  factories = require('./helpers/factories');
  models = require('../models');
  ({ buildPatientExport } = require('../utils/patientDataExport'));
  ({ CATEGORY_KEYS } = require('../utils/patientDataDeletion'));
});

afterEach(async () => {
  await clearTestDb();
});

afterAll(async () => {
  await disconnectTestDb();
});

const waterLog = (patient, date) => models.WaterLog.create({ patientId: patient._id, date });
// One row in every deletion category for `patient`: the shared seed plus the
// four categories it leaves out.
async function seedEveryCategory(patient, dietician) {
  await seedPatientData(patient, dietician);
  await models.ExercisePlan.create({ patientId: patient._id, dieticianId: dietician._id });
  await models.NeedAttentionLog.create({
    dieticianId: dietician._id,
    patientId: patient._id,
    flagDate: new Date(),
  });
  await factories.createDietPlanRequest(patient, dietician);
  // The journey-photo model no longer exists; old documents can still be there.
  await mongoose.connection.collection('journeyimages').insertOne({ patientId: patient._id });
}

const water = (document) => document.categories.waterLog.collections.waterlogs;

describe('buildPatientExport', () => {
  test('every deletion category is present, empty ones with count 0', async () => {
    const patient = await factories.createPatient();

    const { document, counts } = await buildPatientExport(patient);

    expect(Object.keys(document.categories).sort()).toEqual([...CATEGORY_KEYS].sort());
    for (const key of CATEGORY_KEYS) {
      expect(document.categories[key].count).toBe(0);
      expect(counts[key]).toBe(0);
      expect(document.categories[key].truncated).toBe(false);
    }
    expect(document.categories.mealLog.collections.meallogs).toEqual([]);
    expect(document.version).toBe(1);
    expect(new Date(document.exportedAt).toString()).not.toBe('Invalid Date');
  });

  test("includes the patient's records and never another patient's", async () => {
    const patientA = await factories.createPatient();
    const patientB = await factories.createPatient();
    await waterLog(patientA, '2026-09-01');
    await waterLog(patientB, '2026-09-02');
    await models.Notification.create({ userId: patientB._id, title: 'For B', message: 'B only' });

    const { document } = await buildPatientExport(patientA);

    expect(water(document)).toHaveLength(1);
    expect(water(document)[0].date).toBe('2026-09-01');
    expect(document.categories.notification.count).toBe(0);
    expect(JSON.stringify(document)).not.toContain(String(patientB._id));
    expect(JSON.stringify(document)).not.toContain('For B');
  });

  test("no category ever holds another patient's record", async () => {
    const dietician = await factories.createDietician();
    const patientA = await factories.createPatient();
    const patientB = await factories.createPatient();
    await seedEveryCategory(patientA, dietician);

    const baseline = (await buildPatientExport(patientA)).counts;
    // The comparison below only means something if every category had a row.
    for (const key of CATEGORY_KEYS) {
      expect(baseline[key]).toBeGreaterThan(0);
    }

    await seedEveryCategory(patientB, dietician);
    const { document, counts } = await buildPatientExport(patientA);

    for (const key of CATEGORY_KEYS) {
      expect({ key, count: counts[key] }).toEqual({ key, count: baseline[key] });
    }
    expect(JSON.stringify(document)).not.toContain(String(patientB._id));
  });

  test('covers a category resolved through child ids (goal tree)', async () => {
    const patient = await factories.createPatient();
    const dietician = await factories.createDietician();
    const goal = await models.Goal.create({
      patientId: patient._id,
      dieticianId: dietician._id,
      title: 'Lose weight',
      targetValue: 64,
      startDate: new Date(),
      endDate: new Date(Date.now() + 864e5),
    });
    await models.Milestone.create({
      goalId: goal._id,
      type: 'weekly',
      title: 'Week 1',
      date: new Date(),
      sortOrder: 0,
    });

    const { document } = await buildPatientExport(patient);

    expect(document.categories.goal.collections.goals).toHaveLength(1);
    expect(document.categories.goal.collections.milestones).toHaveLength(1);
  });

  test('the user block is an allowlist without identifiers or device tokens', async () => {
    const patient = await factories.createPatient({
      deviceTokens: [{ token: 'fcm-secret', platform: 'android' }],
      consents: [{ type: 'health_data', granted: true, policyVersion: '2026-10', source: 'signup', at: new Date() }],
    });

    const { document } = await buildPatientExport(patient);

    expect(Object.keys(document.user).sort()).toEqual(
      ['consents', 'createdAt', 'email', 'healthProfile', 'profile', 'status'].sort()
    );
    expect(document.user.consents).toHaveLength(1);
    const text = JSON.stringify(document);
    expect(text).not.toContain('supabaseUserId');
    expect(text).not.toContain(patient.supabaseUserId);
    expect(text).not.toContain('fcm-secret');
  });

  test('the per-collection cap truncates and flags the category and document', async () => {
    const patient = await factories.createPatient();
    await waterLog(patient, '2026-09-01');
    await waterLog(patient, '2026-09-02');
    await waterLog(patient, '2026-09-03');

    const { document, counts } = await buildPatientExport(patient, { maxRecords: 2 });

    expect(water(document)).toHaveLength(2);
    expect(document.categories.waterLog.truncated).toBe(true);
    expect(counts.waterLog).toBe(2);
    expect(document.truncated).toBe(true);
    expect(document.categories.mealLog.truncated).toBe(false);
  });
});
