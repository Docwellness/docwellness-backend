/**
 * Placements admin API end to end (openspec add-admin-panel: admin-product-placements).
 * Real Express app + real in-memory MongoDB. Only the admin identity gate and
 * Cloudinary are faked.
 */
const { connectTestDb, disconnectTestDb, clearTestDb } = require('./helpers/testDb');

jest.mock('../middlewares/adminAuth', () => ({
  adminAuth: (req, res, next) => {
    req.admin = { email: 'docwellness.fit@gmail.com', user: { _id: '000000000000000000000009' }, permissions: {} };
    next();
  },
  requirePermission: () => (req, res, next) => next(),
}));

let mockNextUpload = { width: 1200, height: 1200 };
jest.mock('../config/cloudinary', () => ({
  uploader: {
    upload: jest.fn(async () => ({
      secure_url: `https://res.cloudinary.com/x/${Math.random().toString(36).slice(2)}.jpg`,
      public_id: 'pid',
      ...mockNextUpload,
    })),
    destroy: jest.fn(async () => ({})),
  },
}));

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

let request, app, Recipe, AdminAuditLog, ProductPlacement;
const OID = () => new (require('mongoose').Types.ObjectId)();
const DAY = 86400_000;

beforeAll(async () => {
  await connectTestDb();
  request = require('supertest');
  app = require('../config/createApp')();
  Recipe = require('../models/Recipe');
  AdminAuditLog = require('../models/AdminAuditLog');
  ProductPlacement = require('../models/ProductPlacement');
});
afterEach(async () => {
  mockNextUpload = { width: 1200, height: 1200 };
  await clearTestDb();
});
afterAll(async () => {
  await disconnectTestDb();
});

async function makeRecipe(fields = {}) {
  const _id = OID();
  await Recipe.collection.insertOne({
    _id,
    name: 'Whey Protein',
    category: 'Supplements',
    nutrition: { calories: 120 },
    ingredients: [{ name: 'Whey isolate' }],
    ...fields,
  });
  return String(_id);
}
const recipeNow = (id) => Recipe.collection.findOne({ _id: new (require('mongoose').Types.ObjectId)(id) });

async function makeBrand(over = {}) {
  const r = await request(app).post('/api/admin/brands').send({
    name: 'Acme Nutrition',
    legalName: 'Acme Nutrition Pvt Ltd',
    email: 'sales@acme.example',
    licenceNumber: '10020022000123',
    ...over,
  });
  expect(r.status).toBe(201);
  return r.body.data;
}

async function makePlacement(brand, recipeIds, over = {}) {
  const r = await request(app).post('/api/admin/placements').send({
    brandId: brand._id,
    productName: 'Whey 1kg',
    recipeIds,
    startsAt: new Date(Date.now() - DAY).toISOString(),
    endsAt: new Date(Date.now() + 30 * DAY).toISOString(),
    fee: 25000,
    ...over,
  });
  return r;
}

const uploadImage = (id, alt = 'Tub of whey protein') =>
  request(app).post(`/api/admin/placements/${id}/image`).field('alt', alt).attach('image', PNG, { filename: 'p.png', contentType: 'image/png' });

const checks = { checklist: { licenceRecorded: true, noHealthClaims: true } };

describe('brands', () => {
  it('requires a name, legal name and a contact method', async () => {
    expect((await request(app).post('/api/admin/brands').send({ name: 'A', legalName: 'A Ltd' })).status).toBe(400);
    expect((await request(app).post('/api/admin/brands').send({ legalName: 'A Ltd', email: 'a@b.co' })).status).toBe(400);
    expect((await request(app).post('/api/admin/brands').send({ name: 'A', legalName: 'A Ltd', email: 'a@b.co' })).status).toBe(201);
  });
});

describe('placement lifecycle', () => {
  it('draft -> upload -> submit -> approve -> live -> cancel restores the old image', async () => {
    const brand = await makeBrand();
    const rid = await makeRecipe({ image: 'https://old/ai.jpg', imageSource: 'ai-generated' });
    const created = await makePlacement(brand, [rid]);
    expect(created.status).toBe(201);
    const id = created.body.data._id;
    expect(created.body.data.status).toBe('draft');

    // Cannot submit without an image.
    const early = await request(app).post(`/api/admin/placements/${id}/submit`);
    expect(early.status).toBe(400);
    expect(early.body.missing).toEqual(expect.arrayContaining(['Product image']));

    expect((await uploadImage(id)).status).toBe(200);
    expect((await request(app).post(`/api/admin/placements/${id}/submit`)).status).toBe(200);

    // Approval requires both checklist items.
    const noChecks = await request(app).post(`/api/admin/placements/${id}/approve`).send({ checklist: { licenceRecorded: true } });
    expect(noChecks.status).toBe(400);
    expect(noChecks.body.missing).toContain('Checklist: image makes no unapproved health claims');
    expect((await recipeNow(rid)).imageSource).toBe('ai-generated'); // still untouched

    const approved = await request(app).post(`/api/admin/placements/${id}/approve`).send(checks);
    expect(approved.status).toBe(200);
    expect(approved.body.data.status).toBe('active'); // start date already passed
    const live = await recipeNow(rid);
    expect(live.imageSource).toBe('commercial');
    expect(live.sponsoredLabel).toBe('Sponsored');
    expect(live.nutrition).toEqual({ calories: 120 });

    const cancelNoReason = await request(app).post(`/api/admin/placements/${id}/cancel`).send({});
    expect(cancelNoReason.status).toBe(400);
    const cancelled = await request(app).post(`/api/admin/placements/${id}/cancel`).send({ reason: 'Brand withdrew' });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.data.status).toBe('cancelled');
    const back = await recipeNow(rid);
    expect(back.image).toBe('https://old/ai.jpg');
    expect(back.imageSource).toBe('ai-generated');
    expect(back.sponsoredLabel).toBeUndefined();

    const actions = (await AdminAuditLog.find({ targetId: id }).sort({ createdAt: 1 }).lean()).map((a) => a.action);
    expect(actions).toEqual(
      expect.arrayContaining(['placement.create', 'placement.image_set', 'placement.submit', 'placement.approve', 'placement.cancel'])
    );
  });

  it('a placement starting in the future is scheduled and changes nothing yet', async () => {
    const brand = await makeBrand();
    const rid = await makeRecipe({ image: 'https://old/ai.jpg', imageSource: 'ai-generated' });
    const created = await makePlacement(brand, [rid], {
      startsAt: new Date(Date.now() + 5 * DAY).toISOString(),
      endsAt: new Date(Date.now() + 35 * DAY).toISOString(),
    });
    const id = created.body.data._id;
    await uploadImage(id);
    await request(app).post(`/api/admin/placements/${id}/submit`);
    const approved = await request(app).post(`/api/admin/placements/${id}/approve`).send(checks);
    expect(approved.body.data.status).toBe('scheduled');
    expect((await recipeNow(rid)).image).toBe('https://old/ai.jpg');
  });

  it('refuses approval without a brand licence number', async () => {
    const brand = await makeBrand({ licenceNumber: '' });
    const rid = await makeRecipe();
    const id = (await makePlacement(brand, [rid])).body.data._id;
    await uploadImage(id);
    await request(app).post(`/api/admin/placements/${id}/submit`);
    const r = await request(app).post(`/api/admin/placements/${id}/approve`).send(checks);
    expect(r.status).toBe(400);
    expect(r.body.missing).toContain('Manufacturer licence number on the brand');
  });

  it('refuses an overlapping placement on the same entry and names the entry', async () => {
    const brand = await makeBrand();
    const rid = await makeRecipe({ name: 'Omega-3 Fish Oil' });
    const first = (await makePlacement(brand, [rid])).body.data._id;
    await uploadImage(first);
    await request(app).post(`/api/admin/placements/${first}/submit`);
    expect((await request(app).post(`/api/admin/placements/${first}/approve`).send(checks)).status).toBe(200);

    const second = (await makePlacement(brand, [rid], { productName: 'Other brand oil' })).body.data._id;
    await uploadImage(second);
    await request(app).post(`/api/admin/placements/${second}/submit`);
    const clash = await request(app).post(`/api/admin/placements/${second}/approve`).send(checks);
    expect(clash.status).toBe(409);
    expect(clash.body.code).toBe('overlap');
    expect(clash.body.message).toContain('Omega-3 Fish Oil');
  });
});

describe('image validation', () => {
  it('rejects a missing alt text, a non-image type and a too-small image (and removes the upload)', async () => {
    const brand = await makeBrand();
    const rid = await makeRecipe();
    const id = (await makePlacement(brand, [rid])).body.data._id;

    expect((await uploadImage(id, '')).status).toBe(400);

    const gif = await request(app)
      .post(`/api/admin/placements/${id}/image`)
      .field('alt', 'x')
      .attach('image', PNG, { filename: 'p.gif', contentType: 'image/gif' });
    expect(gif.status).toBeGreaterThanOrEqual(400);

    mockNextUpload = { width: 700, height: 900 };
    const small = await uploadImage(id);
    expect(small.status).toBe(400);
    expect(small.body.message).toMatch(/800 x 800/);
    expect(require('../config/cloudinary').uploader.destroy).toHaveBeenCalled();
    expect((await ProductPlacement.findById(id)).image?.url).toBeUndefined();
  });
});

describe('editing an approved placement', () => {
  it('keeps the live version until the change is approved again', async () => {
    const brand = await makeBrand();
    const rid = await makeRecipe({ image: 'https://old/ai.jpg', imageSource: 'ai-generated' });
    const id = (await makePlacement(brand, [rid])).body.data._id;
    await uploadImage(id);
    await request(app).post(`/api/admin/placements/${id}/submit`);
    await request(app).post(`/api/admin/placements/${id}/approve`).send(checks);
    const liveUrl = (await recipeNow(rid)).image;

    // New image + new disclosure wait for approval.
    await uploadImage(id, 'New pack design');
    const edit = await request(app).put(`/api/admin/placements/${id}`).send({ disclosure: 'Paid partnership', fee: 30000 });
    expect(edit.status).toBe(200);
    expect(edit.body.data.status).toBe('active');
    expect(edit.body.data.pendingChange).toBeTruthy();
    expect(edit.body.data.fee).toBe(30000); // fee applies immediately
    const stillLive = await recipeNow(rid);
    expect(stillLive.image).toBe(liveUrl);
    expect(stillLive.sponsoredLabel).toBe('Sponsored');

    const reapproved = await request(app).post(`/api/admin/placements/${id}/approve`).send(checks);
    expect(reapproved.status).toBe(200);
    const nowLive = await recipeNow(rid);
    expect(nowLive.image).not.toBe(liveUrl);
    expect(nowLive.sponsoredLabel).toBe('Paid partnership');

    // Cancelling still returns the ORIGINAL pre-placement image, not the first sponsored one.
    await request(app).post(`/api/admin/placements/${id}/cancel`).send({ reason: 'done' });
    expect((await recipeNow(rid)).image).toBe('https://old/ai.jpg');
  });

  it('does not allow editing an ended placement', async () => {
    const brand = await makeBrand();
    const rid = await makeRecipe();
    const id = (await makePlacement(brand, [rid])).body.data._id;
    await request(app).post(`/api/admin/placements/${id}/cancel`).send({ reason: 'changed mind' });
    const r = await request(app).put(`/api/admin/placements/${id}`).send({ productName: 'x' });
    expect(r.status).toBe(409);
  });
});

describe('validation', () => {
  it('rejects bad dates, unknown entries and a negative fee', async () => {
    const brand = await makeBrand();
    const rid = await makeRecipe();
    const now = Date.now();
    const base = { startsAt: new Date(now).toISOString(), endsAt: new Date(now + DAY).toISOString() };
    expect((await makePlacement(brand, [rid], { startsAt: base.endsAt, endsAt: base.startsAt })).status).toBe(400);
    expect((await makePlacement(brand, [String(OID())])).status).toBe(400);
    expect((await makePlacement(brand, [])).status).toBe(400);
    expect((await makePlacement(brand, [rid], { fee: -5 })).status).toBe(400);
  });
});
