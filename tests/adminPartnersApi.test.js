/**
 * Admin partner requests API (openspec add-admin-panel: admin-partner-requests).
 * Real Express app + real in-memory MongoDB; the admin gate and Cloudinary are faked.
 */
const { connectTestDb, disconnectTestDb, clearTestDb } = require('./helpers/testDb');

jest.mock('../middlewares/adminAuth', () => ({
  adminAuth: (req, res, next) => {
    req.admin = { email: 'docwellness.fit@gmail.com', user: { _id: '000000000000000000000009' }, permissions: {} };
    next();
  },
  requirePermission: () => (req, res, next) => next(),
}));
jest.mock('../config/cloudinary', () => ({
  uploader: {
    upload: jest.fn(async () => ({ public_id: 'docwellness/admin/partners/x/file', resource_type: 'image', format: 'pdf' })),
    destroy: jest.fn(async () => ({})),
  },
  url: jest.fn((id) => `https://res.cloudinary.com/x/signed/${id}`),
}));

let request, app, PartnerRequest, Brand, AdminAuditLog;

beforeAll(async () => {
  await connectTestDb();
  request = require('supertest');
  app = require('../config/createApp')();
  PartnerRequest = require('../models/PartnerRequest');
  Brand = require('../models/Brand');
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
const base = { company: 'Vita Labs', contactName: 'Rohan Kulkarni', email: 'rohan@vitalabs.in', category: 'supplement', expectedValue: 50000 };
const make = async (over = {}) => (await post('/partners', { ...base, confirmDuplicate: true, ...over })).body.data;
const PDF = Buffer.from('%PDF-1.4 test');

describe('create and edit', () => {
  it('creates a request in the new stage with history, owner and an audit entry', async () => {
    const r = await post('/partners', base);
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ stage: 'new', owner: 'docwellness.fit@gmail.com' });
    const doc = await PartnerRequest.findById(r.body.data._id).lean();
    expect(doc.stageHistory).toHaveLength(1);
    expect(await AdminAuditLog.countDocuments({ action: 'partner.create' })).toBe(1);
  });

  it('requires company, contact person, and a phone or an email', async () => {
    expect((await post('/partners', { ...base, company: '' })).status).toBe(400);
    expect((await post('/partners', { ...base, contactName: '' })).status).toBe(400);
    const r = await post('/partners', { ...base, email: '', phone: '' });
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/phone number or an email/);
    expect((await post('/partners', { ...base, email: '', phone: '9822012345' })).status).toBe(201);
  });

  it('warns about an open request for the same company or email, and lets the admin continue', async () => {
    await make();
    const dup = await post('/partners', { ...base, company: 'vita labs' });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('possible_duplicate');
    expect(dup.body.existing.company).toBe('Vita Labs');
    expect((await post('/partners', { ...base, company: 'Other Co' })).status).toBe(409); // same email
    expect((await post('/partners', { ...base, confirmDuplicate: true })).status).toBe(201);
  });

  it('does not warn about a duplicate of a closed request', async () => {
    const a = await make();
    await post(`/partners/${a._id}/stage`, { stage: 'won' });
    expect((await post('/partners', base)).status).toBe(201);
  });

  it('edits fields and keeps validating', async () => {
    const a = await make();
    const ok = await request(app).put(`/api/admin/partners/${a._id}`).send({ expectedValue: 90000, products: 'Whey, Omega-3' });
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ expectedValue: 90000, products: 'Whey, Omega-3' });
    expect((await request(app).put(`/api/admin/partners/${a._id}`).send({ email: '', phone: '' })).status).toBe(400);
  });
});

describe('stages', () => {
  it('moves forward with history, and rejects lost without a reason', async () => {
    const a = await make();
    expect((await post(`/partners/${a._id}/stage`, { stage: 'qualified' })).status).toBe(200);
    expect((await post(`/partners/${a._id}/stage`, { stage: 'proposal' })).status).toBe(200);
    expect((await post(`/partners/${a._id}/stage`, { stage: 'proposal' })).status).toBe(409);
    expect((await post(`/partners/${a._id}/stage`, { stage: 'lost' })).status).toBe(400);
    expect((await post(`/partners/${a._id}/stage`, { stage: 'lost', reason: 'made-up' })).status).toBe(400);
    const lost = await post(`/partners/${a._id}/stage`, { stage: 'lost', reason: 'price' });
    expect(lost.status).toBe(200);
    expect(lost.body.data.closeReason).toBe('price');
    const detail = (await get(`/partners/${a._id}`)).body.data;
    expect(detail.stageHistory.map((h) => h.to)).toEqual(['lost', 'proposal', 'qualified', 'new']);
    // reopening clears the lost reason
    const reopened = await post(`/partners/${a._id}/stage`, { stage: 'negotiation' });
    expect(reopened.body.data.closeReason).toBeUndefined();
  });

  it('discards as unqualified with a listed reason, hides it from the board, and can restore it', async () => {
    const a = await make();
    expect((await post(`/partners/${a._id}/discard`, {})).status).toBe(400);
    expect((await post(`/partners/${a._id}/discard`, { reason: 'price' })).status).toBe(400); // a lost reason, not an unqualified one
    expect((await post(`/partners/${a._id}/discard`, { reason: 'spam' })).status).toBe(200);
    expect((await get('/partners')).body.data.total).toBe(0);
    expect((await get('/partners?discarded=true')).body.data.total).toBe(1);
    expect((await post(`/partners/${a._id}/stage`, { stage: 'qualified' })).status).toBe(409);
    expect((await post(`/partners/${a._id}/restore`)).status).toBe(200);
    expect((await get('/partners')).body.data.total).toBe(1);
  });
});

describe('list and board', () => {
  it('filters, and the per-stage summary equals the list totals', async () => {
    const a = await make({ company: 'A', email: 'a@a.in', expectedValue: 1000 });
    const b = await make({ company: 'B', email: 'b@b.in', expectedValue: 2000, category: 'food' });
    await make({ company: 'C', email: 'c@c.in', expectedValue: 4000 });
    await post(`/partners/${b._id}/stage`, { stage: 'qualified' });
    await post(`/partners/${a._id}/stage`, { stage: 'qualified' });

    const all = (await get('/partners?limit=200')).body.data;
    expect(all.total).toBe(3);
    expect(all.summary.new).toEqual({ count: 1, value: 4000 });
    expect(all.summary.qualified).toEqual({ count: 2, value: 3000 });
    const sumCount = Object.values(all.summary).reduce((s, x) => s + x.count, 0);
    const sumValue = Object.values(all.summary).reduce((s, x) => s + x.value, 0);
    expect(sumCount).toBe(all.total);
    expect(sumValue).toBe(all.items.reduce((s, i) => s + i.expectedValue, 0));

    const q = (await get('/partners?stage=qualified&category=food')).body.data;
    expect(q.items.map((i) => i.company)).toEqual(['B']);
    expect(q.summary.qualified.count).toBe(1); // summary follows the other filters, not the stage
    expect((await get('/partners?q=vita')).body.data.total).toBe(0);
  });
});

describe('notes', () => {
  it('appends notes newest first with the author, and offers no way to edit them', async () => {
    const a = await make();
    expect((await post(`/partners/${a._id}/notes`, { text: '  ' })).status).toBe(400);
    await post(`/partners/${a._id}/notes`, { text: 'First call done' });
    await post(`/partners/${a._id}/notes`, { text: 'Sent brochure' });
    const notes = (await get(`/partners/${a._id}`)).body.data.notes;
    expect(notes.map((n) => n.text)).toEqual(['Sent brochure', 'First call done']);
    expect(notes[0].by).toBe('docwellness.fit@gmail.com');
    expect((await request(app).put(`/api/admin/partners/${a._id}/notes/${notes[0]._id}`).send({ text: 'x' })).status).toBe(404);
    expect((await request(app).delete(`/api/admin/partners/${a._id}/notes/${notes[0]._id}`)).status).toBe(404);
  });
});

describe('attachments', () => {
  const attach = (id, buf, name, type) => request(app).post(`/api/admin/partners/${id}/attachments`).attach('file', buf, { filename: name, contentType: type });

  it('accepts a PDF, lists it without storage details, and audits the download', async () => {
    const a = await make();
    const up = await attach(a._id, PDF, 'brochure.pdf', 'application/pdf');
    expect(up.status).toBe(201);
    const detail = (await get(`/partners/${a._id}`)).body.data;
    expect(detail.attachments[0]).toMatchObject({ name: 'brochure.pdf', mime: 'application/pdf' });
    expect(detail.attachments[0].publicId).toBeUndefined();

    const dl = await get(`/partners/${a._id}/attachments/${up.body.data._id}/download`);
    expect(dl.status).toBe(200);
    expect(dl.body.data.url).toMatch(/^https:\/\//);
    expect(await AdminAuditLog.countDocuments({ action: 'partner.attachment_download' })).toBe(1);
  });

  it('rejects other file types, a mismatched extension, a missing file and files over 10 MB', async () => {
    const a = await make();
    expect((await attach(a._id, Buffer.from('MZ'), 'run.exe', 'application/x-msdownload')).status).toBe(400);
    expect((await attach(a._id, PDF, 'sneaky.exe', 'application/pdf')).status).toBe(400);
    expect((await request(app).post(`/api/admin/partners/${a._id}/attachments`)).status).toBe(400);
    const big = await attach(a._id, Buffer.alloc(10 * 1024 * 1024 + 10, 1), 'big.pdf', 'application/pdf');
    expect(big.status).toBe(400);
    expect(big.body.message).toMatch(/10 MB/);
    expect((await PartnerRequest.findById(a._id).lean()).attachments).toHaveLength(0);
  });

  it('404s for an attachment that does not exist', async () => {
    const a = await make();
    expect((await get(`/partners/${a._id}/attachments/000000000000000000000001/download`)).status).toBe(404);
  });
});

describe('create placement from a won request', () => {
  it('only works once won, copies the brand details, and is idempotent', async () => {
    const a = await make({ phone: '9822012345', products: 'Whey Protein' });
    const early = await post(`/partners/${a._id}/create-brand`);
    expect(early.status).toBe(409);
    expect(early.body.code).toBe('not_won');

    await post(`/partners/${a._id}/stage`, { stage: 'won' });
    const r = await post(`/partners/${a._id}/create-brand`);
    expect(r.status).toBe(201);
    const brand = await Brand.findById(r.body.data.brandId).lean();
    expect(brand).toMatchObject({ name: 'Vita Labs', legalName: 'Vita Labs', contactName: 'Rohan Kulkarni', email: 'rohan@vitalabs.in', phone: '9822012345' });
    expect(brand.notes).toMatch(/Whey Protein/);

    const again = await post(`/partners/${a._id}/create-brand`);
    expect(again.body.data).toMatchObject({ created: false });
    expect(String(again.body.data.brandId)).toBe(String(brand._id));
    expect(await Brand.countDocuments()).toBe(1);
  });
});
