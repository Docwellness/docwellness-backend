/**
 * GET /api/dietician/patients - pagination + server-side name search.
 * Cross-app performance optimization, Phase 1 (task 1.8).
 *
 * The dietician app used to load one page and filter it client-side, so a
 * name search could never find a patient past the first page. Search is now
 * a query param handled inside the aggregation.
 */

const { connectTestDb, disconnectTestDb, clearTestDb } = require('./helpers/testDb');

jest.mock('../utils/supabaseAuth');
const { registerTestToken, clearTestTokens } = require('../utils/supabaseAuth');

let request;
let app;
let createPatient;
let createDietician;
let createDietPlanRequest;

beforeAll(async () => {
  await connectTestDb();
  request = require('supertest');
  app = require('../config/createApp')();
  ({ createPatient, createDietician, createDietPlanRequest } = require('./helpers/factories'));
});

afterEach(async () => {
  clearTestTokens();
  await clearTestDb();
});

afterAll(async () => {
  await disconnectTestDb();
});

// A "new"-tab patient: a request with no active plan and not completed.
const newPatientNamed = async (dietician, fullName) => {
  const patient = await createPatient({ profile: { fullName } });
  await createDietPlanRequest(patient, dietician, {
    hasActivePlan: false,
    completedAt: null,
  });
  return patient;
};

const list = (token, query) =>
  request(app)
    .get(`/api/dietician/patients${query}`)
    .set('Authorization', `Bearer ${token}`);

describe('GET /api/dietician/patients', () => {
  test('paginates the new-tab list and reports page metadata', async () => {
    const dietician = await createDietician();
    for (const name of ['Aisha Khan', 'Bilal Ahmed', 'Carla Diaz', 'Deepak Rao', 'Esha Verma']) {
      await newPatientNamed(dietician, name); // eslint-disable-line no-await-in-loop
    }
    registerTestToken('d', dietician._id);

    const p1 = await list('d', '?tab=new&page=1&limit=2');
    expect(p1.status).toBe(200);
    expect(p1.body.data).toHaveLength(2);
    expect(p1.body.pagination).toEqual(
      expect.objectContaining({ page: 1, limit: 2, total: 5, hasMore: true })
    );

    const p3 = await list('d', '?tab=new&page=3&limit=2');
    expect(p3.body.data).toHaveLength(1);
    expect(p3.body.pagination.hasMore).toBe(false);
  });

  test('?search= filters by patient name, case-insensitively, across the whole list', async () => {
    const dietician = await createDietician();
    await newPatientNamed(dietician, 'Aisha Khan');
    await newPatientNamed(dietician, 'Bilal Ahmed');
    // Sort is by createdAt desc, so "Zoya" lands on a later page than limit=2.
    await newPatientNamed(dietician, 'Carla Diaz');
    await newPatientNamed(dietician, 'Deepak Rao');
    const zoya = await newPatientNamed(dietician, 'Zoya Ahmed');
    registerTestToken('d', dietician._id);

    // "ahmed" matches Bilal Ahmed + Zoya Ahmed even though Zoya is not on page 1
    const res = await list('d', '?tab=new&limit=2&search=ahmed');
    expect(res.status).toBe(200);
    const names = res.body.data.map((r) => r.fullName).sort();
    expect(res.body.pagination.total).toBe(2);
    expect(names).toEqual(['Bilal Ahmed', 'Zoya Ahmed']);
    expect(res.body.data.some((r) => r.patientId === zoya._id.toString())).toBe(true);
  });

  test('a regex metacharacter in the search term is treated literally', async () => {
    const dietician = await createDietician();
    await newPatientNamed(dietician, 'Normal Name');
    registerTestToken('d', dietician._id);

    const res = await list('d', '?tab=new&search=' + encodeURIComponent('.*'));
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(0); // ".*" is not a literal substring of "Normal Name"
  });

  test('an empty search behaves exactly like no search', async () => {
    const dietician = await createDietician();
    await newPatientNamed(dietician, 'Solo Patient');
    registerTestToken('d', dietician._id);

    const res = await list('d', '?tab=new&search=');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
  });
});
