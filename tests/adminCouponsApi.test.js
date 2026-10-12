/**
 * Admin coupons API (openspec add-admin-panel: admin-payments, coupon management).
 */
const { connectTestDb, disconnectTestDb, clearTestDb } = require('./helpers/testDb');

jest.mock('../middlewares/adminAuth', () => ({
  adminAuth: (req, res, next) => {
    req.admin = { email: 'docwellness.fit@gmail.com', user: { _id: '000000000000000000000009' }, permissions: {} };
    next();
  },
  requirePermission: () => (req, res, next) => next(),
}));

let request, app, f, Coupon, AdminAuditLog;
const DAY = 86400_000;

beforeAll(async () => {
  await connectTestDb();
  request = require('supertest');
  app = require('../config/createApp')();
  f = require('./helpers/factories');
  Coupon = require('../models/Coupon');
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
const put = (p, body) => request(app).put(`/api/admin${p}`).send(body || {});
const valid = (dieticianId, over = {}) => ({
  dieticianId,
  name: 'Diwali offer',
  code: 'diwali10',
  discountPercentage: 10,
  validTill: new Date(Date.now() + 30 * DAY).toISOString(),
  ...over,
});

describe('create', () => {
  it('creates a coupon for a dietician with an upper-cased code and audits it', async () => {
    const d = await f.createDietician();
    const r = await post('/coupons', valid(d._id));
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ code: 'DIWALI10', discountPercentage: 10, isActive: true, status: 'live' });
    expect(await AdminAuditLog.countDocuments({ action: 'coupon.create' })).toBe(1);
  });

  it('rejects a duplicate code, even one owned by another dietician', async () => {
    const a = await f.createDietician();
    const b = await f.createDietician();
    await post('/coupons', valid(a._id));
    expect((await post('/coupons', valid(a._id))).status).toBe(409);
    expect((await post('/coupons', valid(b._id, { code: 'Diwali10' }))).status).toBe(409);
    expect(await Coupon.countDocuments()).toBe(1);
  });

  it('rejects bad discounts, codes, past dates and unknown owners', async () => {
    const d = await f.createDietician();
    expect((await post('/coupons', valid(d._id, { discountPercentage: 0 }))).status).toBe(400);
    expect((await post('/coupons', valid(d._id, { discountPercentage: 101 }))).status).toBe(400);
    expect((await post('/coupons', valid(d._id, { code: 'a b' }))).status).toBe(400);
    expect((await post('/coupons', valid(d._id, { validTill: new Date(Date.now() - DAY).toISOString() }))).status).toBe(400);
    expect((await post('/coupons', valid(undefined))).status).toBe(400);
    expect((await post('/coupons', valid('000000000000000000000001'))).status).toBe(400);
    expect((await post('/coupons', valid((await f.createPatient())._id))).status).toBe(400); // a patient is not a dietician
  });
});

describe('list and update', () => {
  it('shows live, expired and inactive coupons and filters by status', async () => {
    const d = await f.createDietician();
    await post('/coupons', valid(d._id, { code: 'LIVE1' }));
    await post('/coupons', valid(d._id, { code: 'OFF1', isActive: false }));
    await Coupon.create({ dieticianId: d._id, name: 'Old', code: 'OLD1', discountPercentage: 5, validTill: new Date(Date.now() - DAY) });
    const byStatus = async (s) => (await get(`/coupons?status=${s}`)).body.data.items.map((i) => i.code);
    expect(await byStatus('live')).toEqual(['LIVE1']);
    expect(await byStatus('inactive')).toEqual(['OFF1']);
    expect(await byStatus('expired')).toEqual(['OLD1']);
    expect((await get('/coupons?q=old')).body.data.items[0].status).toBe('expired');
  });

  it('edits the discount, end date and active flag, but never the code or owner', async () => {
    const a = await f.createDietician();
    const b = await f.createDietician();
    const c = (await post('/coupons', valid(a._id))).body.data;
    const r = await put(`/coupons/${c._id}`, { code: 'HACK', dieticianId: b._id, discountPercentage: 25, isActive: false });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ code: 'DIWALI10', discountPercentage: 25, isActive: false, status: 'inactive' });
    expect(String(r.body.data.dieticianId)).toBe(String(a._id));
    expect((await put(`/coupons/${c._id}`, { discountPercentage: 150 })).status).toBe(400);
    expect((await put('/coupons/000000000000000000000001', { name: 'x' })).status).toBe(404);
    expect(await AdminAuditLog.countDocuments({ action: 'coupon.update' })).toBe(1);
  });

  it('a deactivated coupon stops validating for patients', async () => {
    const d = await f.createDietician();
    const c = (await post('/coupons', valid(d._id))).body.data;
    await put(`/coupons/${c._id}`, { isActive: false });
    expect(await Coupon.exists({ code: 'DIWALI10', isActive: true })).toBeNull();
  });
});
