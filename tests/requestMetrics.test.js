/**
 * Request + DB-query metrics - perf-observability-and-validation task 2.1.
 * Covers utils/requestMetrics directly and end-to-end through the metrics
 * middleware + GET /api/internal/metrics.
 */

// Must be set before config/environment.js is first required (via testDb).
process.env.CRON_SECRET = 'test-cron-secret';

const { connectTestDb, disconnectTestDb, clearTestDb } = require('./helpers/testDb');

jest.mock('../utils/supabaseAuth');
const { registerTestToken, clearTestTokens } = require('../utils/supabaseAuth');

const metrics = require('../utils/requestMetrics');

let request;
let app;
let mongoose;
let connectDB;
let createPatient;

beforeAll(async () => {
  await connectTestDb();
  request = require('supertest');
  app = require('../config/createApp')();
  mongoose = require('mongoose');
  connectDB = require('../config/database');
  ({ createPatient } = require('./helpers/factories'));
  // testDb connects directly (not via connectDB), so wire the same
  // command-monitoring listeners the app would.
  connectDB.wireCommandMetrics(mongoose.connection);
});

afterEach(async () => {
  metrics._reset();
  clearTestTokens();
  await clearTestDb();
});

afterAll(async () => {
  await disconnectTestDb();
});

describe('utils/requestMetrics', () => {
  test('recordRequest -> snapshot computes per-route percentiles', () => {
    for (const ms of [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]) {
      metrics.recordRequest({ route: '/x', method: 'GET', status: 200, durationMs: ms, dbCount: 2, dbMs: 4 });
    }
    const snap = metrics.snapshot();
    const r = snap.routes['GET /x'];
    expect(r.count).toBe(10);
    expect(r.p50Ms).toBe(50);
    expect(r.p95Ms).toBe(100);
    expect(r.p99Ms).toBe(100);
    expect(r.maxMs).toBe(100);
    expect(r.avgDbQueries).toBe(2);
    expect(r.avgDbMs).toBe(4);
    expect(r.statuses).toEqual({ 200: 10 });
  });

  test('recordCommand attributes to the current request store, and adds to global totals', () => {
    // The live command-monitoring listener also feeds the global totals, so
    // assert deltas around these explicit calls rather than absolutes.
    const before = metrics.snapshot().db;

    const store = metrics.newRequestStore();
    metrics.runInRequestContext(store, () => {
      metrics.recordCommand('find', 3, true);
      metrics.recordCommand('aggregate', 7, true);
    });
    // outside any request context - global only, not attributed to a store
    metrics.recordCommand('insert', 1, true);

    expect(store).toEqual({ dbCount: 2, dbMs: 10 });

    const after = metrics.snapshot().db;
    expect(after.totalCommands - before.totalCommands).toBe(3);
    expect(after.totalMs - before.totalMs).toBe(11);
    expect((after.byCommand.find || 0) - (before.byCommand.find || 0)).toBe(1);
    expect((after.byCommand.aggregate || 0) - (before.byCommand.aggregate || 0)).toBe(1);
  });

  test('a failed command bumps the failed counter', () => {
    const before = metrics.snapshot().db.failed;
    metrics.recordCommand('find', 2, false);
    expect(metrics.snapshot().db.failed - before).toBe(1);
  });
});

describe('GET /api/internal/metrics', () => {
  test('401 without the shared secret', async () => {
    const res = await request(app).get('/api/internal/metrics');
    expect(res.status).toBe(401);
  });

  test('reports a route that was actually hit, with latency + DB attribution', async () => {
    const patient = await createPatient();
    registerTestToken('p', patient._id);

    // /api/patient/auth/me: one authed request that reads the DB.
    const hit = await request(app).get('/api/patient/auth/me').set('Authorization', 'Bearer p');
    expect(hit.status).toBe(200);

    const res = await request(app)
      .get('/api/internal/metrics')
      .set('x-cron-secret', 'test-cron-secret');

    expect(res.status).toBe(200);
    const { requests, jobQueue } = res.body.data;

    const meKey = Object.keys(requests.routes).find((k) => k.includes('/auth/me'));
    expect(meKey).toBeDefined();
    const r = requests.routes[meKey];
    expect(r.count).toBeGreaterThanOrEqual(1);
    expect(r.p50Ms).toBeGreaterThan(0);
    expect(r.avgDbQueries).toBeGreaterThan(0); // auth middleware + handler read Mongo
    expect(requests.db.totalCommands).toBeGreaterThan(0);
    expect(jobQueue).toBeDefined();
  });

  test('an unmatched route is bucketed as (unmatched), not as a distinct URL', async () => {
    await request(app).get('/api/patient/definitely-not-a-route-abc');
    await request(app).get('/api/patient/definitely-not-a-route-xyz');

    const res = await request(app)
      .get('/api/internal/metrics')
      .set('x-cron-secret', 'test-cron-secret');

    const keys = Object.keys(res.body.data.requests.routes);
    expect(keys).toContain('GET (unmatched)');
    expect(res.body.data.requests.routes['GET (unmatched)'].count).toBe(2);
    expect(keys.some((k) => k.includes('definitely-not-a-route'))).toBe(false);
  });
});
