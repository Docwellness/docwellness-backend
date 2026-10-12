/**
 * Audit log against the REAL model and a real in-memory MongoDB
 * (openspec add-admin-panel: admin-audit-log). The earlier middleware tests
 * mock the model, which is how a broken save hook went unnoticed.
 */
const { connectTestDb, disconnectTestDb, clearTestDb } = require('./helpers/testDb');

let AdminAuditLog, writeAudit, audited;

beforeAll(async () => {
  await connectTestDb();
  AdminAuditLog = require('../models/AdminAuditLog');
  ({ writeAudit, audited } = require('../utils/adminAudit'));
});
afterEach(async () => {
  await clearTestDb();
});
afterAll(async () => {
  await disconnectTestDb();
});

const req = () => ({
  admin: { email: 'docwellness.fit@gmail.com', user: { _id: '000000000000000000000009' } },
  ip: '203.0.113.9',
  id: 'req-1',
  headers: { 'user-agent': 'jest' },
});

describe('AdminAuditLog model', () => {
  it('stores an entry with the full set of fields', async () => {
    await writeAudit(req(), {
      action: 'payment.confirm',
      targetType: 'payment',
      targetId: 'p1',
      before: { status: 'pending' },
      after: { status: 'confirmed' },
      reason: 'verified screenshot',
    });
    const [e] = await AdminAuditLog.find({}).lean();
    expect(e).toMatchObject({
      actorEmail: 'docwellness.fit@gmail.com',
      action: 'payment.confirm',
      outcome: 'success',
      targetType: 'payment',
      targetId: 'p1',
      before: { status: 'pending' },
      after: { status: 'confirmed' },
      reason: 'verified screenshot',
      ip: '203.0.113.9',
      userAgent: 'jest',
      requestId: 'req-1',
    });
    expect(e.createdAt).toBeInstanceOf(Date);
  });

  it('is append-only: saves, updates and deletes of existing entries are refused', async () => {
    const e = await AdminAuditLog.create({ action: 'x.y', actorEmail: 'a@b.co' });
    e.reason = 'tampered';
    await expect(e.save()).rejects.toThrow(/append-only/);
    await expect(AdminAuditLog.updateOne({ _id: e._id }, { $set: { action: 'z' } })).rejects.toThrow(/append-only/);
    await expect(AdminAuditLog.findOneAndUpdate({ _id: e._id }, { $set: { action: 'z' } })).rejects.toThrow(/append-only/);
    await expect(AdminAuditLog.deleteOne({ _id: e._id })).rejects.toThrow(/append-only/);
    await expect(AdminAuditLog.deleteMany({})).rejects.toThrow(/append-only/);
    expect(await AdminAuditLog.countDocuments()).toBe(1);
    expect((await AdminAuditLog.findById(e._id).lean()).action).toBe('x.y');
  });
});

describe('audited()', () => {
  it('records the intent first and then runs the mutation', async () => {
    const order = [];
    await audited(req(), { action: 'brand.create', targetType: 'brand', targetId: 'b1' }, async () => {
      order.push('mutate');
      expect(await AdminAuditLog.countDocuments({ action: 'brand.create' })).toBe(1); // already written
    });
    expect(order).toEqual(['mutate']);
  });

  it('does not run the mutation when the audit entry cannot be written', async () => {
    const mutate = jest.fn();
    // `action` is required, so this entry is invalid and the write fails.
    await expect(audited(req(), { targetType: 'brand' }, mutate)).rejects.toThrow();
    expect(mutate).not.toHaveBeenCalled();
  });

  it('appends a failed entry when the mutation throws (history is never edited)', async () => {
    await expect(
      audited(req(), { action: 'brand.update', targetType: 'brand', targetId: 'b2' }, async () => {
        throw new Error('db down');
      })
    ).rejects.toThrow('db down');
    const rows = await AdminAuditLog.find({ targetId: 'b2' }).sort({ createdAt: 1 }).lean();
    expect(rows.map((r) => r.outcome)).toEqual(['success', 'failed']);
    expect(rows[1].meta.error).toBe('db down');
  });
});
