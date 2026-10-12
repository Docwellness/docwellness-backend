const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const multer = require('multer');
const cloudinary = require('../../config/cloudinary');
const PartnerRequest = require('../../models/PartnerRequest');
const Brand = require('../../models/Brand');
const { audited, writeAudit } = require('../../utils/adminAudit');

const { STAGES, CATEGORIES, SOURCES, LOST_REASONS, UNQUALIFIED_REASONS } = PartnerRequest;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const ATTACHMENT_TYPES = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png' };

const bad = (res, message, extra = {}) => res.status(400).json({ success: false, message, ...extra });
const isId = (v) => mongoose.Types.ObjectId.isValid(String(v));
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Multer for attachments: PDF/JPG/PNG, 10 MB. Oversize is reported as a normal 400 by the route wrapper. */
const attachmentUpload = multer({
  dest: path.join(require('os').tmpdir(), 'docwellness-partner-uploads'),
  limits: { fileSize: MAX_ATTACHMENT_BYTES },
}).single('file');

function pick(body) {
  const b = body || {};
  const out = {};
  const str = (k) => {
    if (b[k] !== undefined) out[k] = String(b[k] ?? '').trim();
  };
  ['company', 'contactName', 'phone', 'email', 'products', 'budgetRange', 'owner'].forEach(str);
  if (b.category !== undefined) out.category = b.category;
  if (b.source !== undefined) out.source = b.source;
  if (b.expectedValue !== undefined) out.expectedValue = Number(b.expectedValue || 0);
  if (b.expectedCloseAt !== undefined) out.expectedCloseAt = b.expectedCloseAt ? new Date(b.expectedCloseAt) : null;
  return out;
}

function validate(d) {
  if (!d.company) return 'Enter the company name';
  if (!d.contactName) return 'Enter the contact person';
  if (!d.phone && !d.email) return 'Enter a phone number or an email so the contact can be reached';
  if (d.email && !/^\S+@\S+\.\S+$/.test(d.email)) return 'Enter a valid email';
  if (d.category && !CATEGORIES.includes(d.category)) return 'Choose a valid category';
  if (d.source && !SOURCES.includes(d.source)) return 'Choose a valid lead source';
  if (d.expectedValue !== undefined && (!Number.isFinite(d.expectedValue) || d.expectedValue < 0)) return 'Expected value must be zero or more';
  if (d.expectedCloseAt && Number.isNaN(new Date(d.expectedCloseAt).getTime())) return 'Enter a valid expected close date';
  return null;
}

const present = (r) => ({
  ...r,
  attachments: (r.attachments || []).map((a) => ({
    _id: a._id,
    name: a.name,
    bytes: a.bytes,
    mime: a.mime,
    uploadedAt: a.uploadedAt,
    uploadedBy: a.uploadedBy,
  })),
});

function listFilter(q) {
  const and = [];
  if (q.category && CATEGORIES.includes(q.category)) and.push({ category: q.category });
  if (q.owner) and.push({ owner: String(q.owner) });
  if (q.from || q.to) {
    const range = {};
    if (q.from && !Number.isNaN(new Date(q.from).getTime())) range.$gte = new Date(q.from);
    if (q.to && !Number.isNaN(new Date(q.to).getTime())) range.$lte = new Date(q.to);
    if (Object.keys(range).length) and.push({ createdAt: range });
  }
  const text = String(q.q || '').trim().slice(0, 80);
  if (text) {
    const rx = new RegExp(escapeRegex(text), 'i');
    and.push({ $or: [{ company: rx }, { contactName: rx }, { email: rx }, { products: rx }] });
  }
  if (q.discarded === 'true') and.push({ discarded: true });
  else and.push({ discarded: { $ne: true } });
  return and;
}

// GET /api/admin/partners?stage=&category=&owner=&from=&to=&q=&discarded=&page=&limit=
// `summary` always covers every stage for the same filters (stage excluded), so
// the board columns and the list agree.
exports.list = async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 25));
    const base = listFilter(req.query);
    const withStage = [...base];
    if (req.query.stage && STAGES.includes(req.query.stage)) withStage.push({ stage: req.query.stage });

    const [items, total, grouped] = await Promise.all([
      PartnerRequest.find(withStage.length ? { $and: withStage } : {})
        .select('-notes -stageHistory -attachments')
        .sort({ updatedAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      PartnerRequest.countDocuments(withStage.length ? { $and: withStage } : {}),
      PartnerRequest.aggregate([
        { $match: base.length ? { $and: base } : {} },
        { $group: { _id: '$stage', count: { $sum: 1 }, value: { $sum: '$expectedValue' } } },
      ]),
    ]);
    const summary = Object.fromEntries(STAGES.map((s) => [s, { count: 0, value: 0 }]));
    grouped.forEach((g) => {
      if (summary[g._id]) summary[g._id] = { count: g.count, value: g.value };
    });
    res.json({ success: true, data: { items, total, page, limit, summary } });
  } catch (err) {
    next(err);
  }
};

exports.get = async (req, res, next) => {
  try {
    if (!isId(req.params.id)) return bad(res, 'Invalid request id');
    const r = await PartnerRequest.findById(req.params.id).lean();
    if (!r) return res.status(404).json({ success: false, message: 'Partner request not found' });
    res.json({
      success: true,
      data: { ...present(r), notes: [...(r.notes || [])].reverse(), stageHistory: [...(r.stageHistory || [])].reverse() },
    });
  } catch (err) {
    next(err);
  }
};

// POST /api/admin/partners  (409 possible_duplicate unless confirmDuplicate)
exports.create = async (req, res, next) => {
  try {
    const d = pick(req.body);
    const err = validate(d);
    if (err) return bad(res, err);

    if (!req.body?.confirmDuplicate) {
      const or = [{ company: new RegExp(`^${escapeRegex(d.company)}$`, 'i') }];
      if (d.email) or.push({ email: d.email });
      const existing = await PartnerRequest.findOne({ $or: or, stage: { $nin: ['won', 'lost'] }, discarded: { $ne: true } })
        .select('company stage contactName')
        .lean();
      if (existing) {
        return res.status(409).json({
          success: false,
          code: 'possible_duplicate',
          message: `An open request for ${existing.company} already exists (${existing.stage}).`,
          existing: { _id: existing._id, company: existing.company, stage: existing.stage },
        });
      }
    }

    const r = new PartnerRequest({
      ...d,
      owner: d.owner || req.admin.email,
      createdBy: req.admin.email,
      stageHistory: [{ from: null, to: 'new', by: req.admin.email, at: new Date() }],
    });
    await audited(req, { action: 'partner.create', targetType: 'partner', targetId: String(r._id), after: d }, () => r.save());
    res.status(201).json({ success: true, data: present(r.toObject()) });
  } catch (err) {
    next(err);
  }
};

exports.update = async (req, res, next) => {
  try {
    if (!isId(req.params.id)) return bad(res, 'Invalid request id');
    const r = await PartnerRequest.findById(req.params.id);
    if (!r) return res.status(404).json({ success: false, message: 'Partner request not found' });
    const d = pick(req.body);
    const merged = { ...r.toObject(), ...d };
    const err = validate(merged);
    if (err) return bad(res, err);
    const before = pick(r.toObject());
    await audited(req, { action: 'partner.update', targetType: 'partner', targetId: String(r._id), before, after: d }, async () => {
      r.set(d);
      await r.save();
    });
    res.json({ success: true, data: present(r.toObject()) });
  } catch (err) {
    next(err);
  }
};

// POST /api/admin/partners/:id/stage  { stage, reason? }
exports.moveStage = async (req, res, next) => {
  try {
    if (!isId(req.params.id)) return bad(res, 'Invalid request id');
    const { stage, reason } = req.body || {};
    if (!STAGES.includes(stage)) return bad(res, 'Choose a valid stage');
    const r = await PartnerRequest.findById(req.params.id);
    if (!r) return res.status(404).json({ success: false, message: 'Partner request not found' });
    if (r.discarded) return res.status(409).json({ success: false, message: 'This request was discarded. Restore it first.' });
    if (r.stage === stage) return res.status(409).json({ success: false, message: 'It is already in that stage' });
    if (stage === 'lost' && !LOST_REASONS.includes(reason)) {
      return bad(res, 'Choose why it was lost', { reasons: LOST_REASONS });
    }
    const from = r.stage;
    await audited(
      req,
      {
        action: 'partner.stage',
        targetType: 'partner',
        targetId: String(r._id),
        before: { stage: from },
        after: { stage },
        reason: stage === 'lost' ? reason : undefined,
      },
      async () => {
        r.stage = stage;
        r.closeReason = stage === 'lost' ? reason : undefined;
        r.stageHistory.push({ from, to: stage, at: new Date(), by: req.admin.email, reason: stage === 'lost' ? reason : undefined });
        await r.save();
      }
    );
    res.json({ success: true, data: present(r.toObject()) });
  } catch (err) {
    next(err);
  }
};

// POST /api/admin/partners/:id/discard  { reason }   |   /restore
exports.discard = async (req, res, next) => {
  try {
    if (!isId(req.params.id)) return bad(res, 'Invalid request id');
    const { reason } = req.body || {};
    if (!UNQUALIFIED_REASONS.includes(reason)) return bad(res, 'Choose why it is being discarded', { reasons: UNQUALIFIED_REASONS });
    const r = await PartnerRequest.findById(req.params.id);
    if (!r) return res.status(404).json({ success: false, message: 'Partner request not found' });
    if (r.discarded) return res.status(409).json({ success: false, message: 'Already discarded' });
    await audited(req, { action: 'partner.discard', targetType: 'partner', targetId: String(r._id), reason }, async () => {
      r.discarded = true;
      r.closeReason = reason;
      r.stageHistory.push({ from: r.stage, to: 'discarded', at: new Date(), by: req.admin.email, reason });
      await r.save();
    });
    res.json({ success: true, data: present(r.toObject()) });
  } catch (err) {
    next(err);
  }
};

exports.restore = async (req, res, next) => {
  try {
    if (!isId(req.params.id)) return bad(res, 'Invalid request id');
    const r = await PartnerRequest.findById(req.params.id);
    if (!r) return res.status(404).json({ success: false, message: 'Partner request not found' });
    if (!r.discarded) return res.status(409).json({ success: false, message: 'It is not discarded' });
    await audited(req, { action: 'partner.restore', targetType: 'partner', targetId: String(r._id) }, async () => {
      r.discarded = false;
      r.closeReason = r.stage === 'lost' ? r.closeReason : undefined;
      r.stageHistory.push({ from: 'discarded', to: r.stage, at: new Date(), by: req.admin.email });
      await r.save();
    });
    res.json({ success: true, data: present(r.toObject()) });
  } catch (err) {
    next(err);
  }
};

// POST /api/admin/partners/:id/notes  { text }
exports.addNote = async (req, res, next) => {
  try {
    if (!isId(req.params.id)) return bad(res, 'Invalid request id');
    const text = String(req.body?.text || '').trim();
    if (!text) return bad(res, 'Write a note first');
    if (text.length > 2000) return bad(res, 'Keep the note under 2000 characters');
    const r = await PartnerRequest.findById(req.params.id);
    if (!r) return res.status(404).json({ success: false, message: 'Partner request not found' });
    await audited(req, { action: 'partner.note', targetType: 'partner', targetId: String(r._id), meta: { length: text.length } }, async () => {
      r.notes.push({ text, by: req.admin.email, at: new Date() });
      await r.save();
    });
    res.status(201).json({ success: true, data: r.notes[r.notes.length - 1] });
  } catch (err) {
    next(err);
  }
};

/** Runs multer and turns its errors (oversize) into a 400 instead of a 500. */
exports.receiveFile = (req, res, next) => {
  attachmentUpload(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') return bad(res, 'The file must be 10 MB or smaller');
    return bad(res, err.message || 'Could not read the file');
  });
};

// POST /api/admin/partners/:id/attachments  (multipart: file)
exports.addAttachment = async (req, res, next) => {
  const tmp = req.file?.path;
  try {
    if (!isId(req.params.id)) return bad(res, 'Invalid request id');
    if (!req.file) return bad(res, 'Choose a file to attach');
    const ext = ATTACHMENT_TYPES[req.file.mimetype];
    if (!ext || path.extname(req.file.originalname).toLowerCase().replace('.', '').replace('jpeg', 'jpg') !== ext) {
      return bad(res, 'Attach a PDF, JPG or PNG file');
    }
    if (req.file.size > MAX_ATTACHMENT_BYTES) return bad(res, 'The file must be 10 MB or smaller');
    const r = await PartnerRequest.findById(req.params.id);
    if (!r) return res.status(404).json({ success: false, message: 'Partner request not found' });
    if (r.attachments.length >= 20) return bad(res, 'A request can have at most 20 attachments');

    // Authenticated delivery: the file is only reachable through a signed link made by the download route.
    const up = await cloudinary.uploader.upload(req.file.path, {
      folder: `docwellness/admin/partners/${r._id}`,
      resource_type: 'auto',
      type: 'authenticated',
    });
    const att = {
      name: path.basename(req.file.originalname).slice(0, 120),
      publicId: up.public_id,
      resourceType: up.resource_type || 'image',
      format: up.format || ext,
      mime: req.file.mimetype,
      bytes: req.file.size,
      uploadedBy: req.admin.email,
      uploadedAt: new Date(),
    };
    await audited(req, { action: 'partner.attachment_add', targetType: 'partner', targetId: String(r._id), after: { name: att.name, bytes: att.bytes } }, async () => {
      r.attachments.push(att);
      await r.save();
    });
    const saved = r.attachments[r.attachments.length - 1];
    res.status(201).json({ success: true, data: { _id: saved._id, name: saved.name, bytes: saved.bytes, mime: saved.mime, uploadedAt: saved.uploadedAt, uploadedBy: saved.uploadedBy } });
  } catch (err) {
    next(err);
  } finally {
    if (tmp) fs.promises.unlink(tmp).catch(() => {});
  }
};

// GET /api/admin/partners/:id/attachments/:attId/download -> { url } (signed, audited)
exports.downloadAttachment = async (req, res, next) => {
  try {
    const { id, attId } = req.params;
    if (!isId(id) || !isId(attId)) return bad(res, 'Invalid id');
    const r = await PartnerRequest.findById(id).lean();
    const att = r?.attachments?.find((a) => String(a._id) === String(attId));
    if (!att) return res.status(404).json({ success: false, message: 'Attachment not found' });
    await writeAudit(req, { action: 'partner.attachment_download', targetType: 'partner', targetId: String(id), meta: { attachment: att.name } });
    const url = cloudinary.url(att.publicId, {
      resource_type: att.resourceType,
      type: 'authenticated',
      sign_url: true,
      secure: true,
      format: att.resourceType === 'raw' ? undefined : att.format,
      flags: `attachment:${encodeURIComponent(att.name.replace(/\.[^.]+$/, ''))}`,
    });
    res.json({ success: true, data: { url, name: att.name } });
  } catch (err) {
    next(err);
  }
};

// POST /api/admin/partners/:id/create-brand  (won requests only; idempotent)
exports.createBrand = async (req, res, next) => {
  try {
    if (!isId(req.params.id)) return bad(res, 'Invalid request id');
    const r = await PartnerRequest.findById(req.params.id);
    if (!r) return res.status(404).json({ success: false, message: 'Partner request not found' });
    if (r.stage !== 'won') return res.status(409).json({ success: false, message: 'Only a won request can start a placement', code: 'not_won' });

    if (r.brandId) {
      const existing = await Brand.findById(r.brandId).lean();
      if (existing) return res.json({ success: true, data: { brandId: existing._id, created: false } });
    }
    const brand = new Brand({
      name: r.company,
      legalName: r.company,
      contactName: r.contactName,
      phone: r.phone,
      email: r.email,
      notes: `Created from partner request. Interested in: ${r.products || 'not stated'}`,
      createdBy: req.admin.email,
    });
    await audited(req, { action: 'partner.create_brand', targetType: 'partner', targetId: String(r._id), after: { brandId: String(brand._id) } }, async () => {
      await brand.save();
      r.brandId = brand._id;
      await r.save();
    });
    res.status(201).json({ success: true, data: { brandId: brand._id, created: true } });
  } catch (err) {
    next(err);
  }
};

exports.reasons = (req, res) =>
  res.json({ success: true, data: { stages: STAGES, categories: CATEGORIES, sources: SOURCES, lost: LOST_REASONS, unqualified: UNQUALIFIED_REASONS } });
