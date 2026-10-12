const mongoose = require('mongoose');
const Coupon = require('../../models/Coupon');
const User = require('../../models/User');
const { audited } = require('../../utils/adminAudit');

const bad = (res, message) => res.status(400).json({ success: false, message });
const isId = (v) => mongoose.Types.ObjectId.isValid(String(v));
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function parseFields(b, { partial = false } = {}) {
  const out = {};
  if (!partial || b.name !== undefined) out.name = String(b.name || '').trim();
  if (!partial || b.code !== undefined) out.code = String(b.code || '').trim().toUpperCase();
  if (!partial || b.discountPercentage !== undefined) out.discountPercentage = Number(b.discountPercentage);
  if (!partial || b.validTill !== undefined) out.validTill = new Date(b.validTill);
  if (b.isActive !== undefined) out.isActive = b.isActive === true || b.isActive === 'true';
  return out;
}

function validate(d, { partial = false } = {}) {
  if ('name' in d && !d.name) return 'Enter a coupon name';
  if ('code' in d && !/^[A-Z0-9_-]{3,20}$/.test(d.code)) return 'The code must be 3 to 20 letters, numbers, - or _';
  if ('discountPercentage' in d && (!Number.isFinite(d.discountPercentage) || d.discountPercentage < 1 || d.discountPercentage > 100)) {
    return 'The discount must be between 1 and 100 percent';
  }
  if ('validTill' in d) {
    if (Number.isNaN(d.validTill.getTime())) return 'Enter a valid end date';
    if (!partial && d.validTill.getTime() < Date.now()) return 'The end date must be in the future';
  }
  return null;
}

const status = (c) => (!c.isActive ? 'inactive' : new Date(c.validTill) < new Date() ? 'expired' : 'live');

// GET /api/admin/coupons?q=&status=&dieticianId=&page=&limit=
exports.list = async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 25));
    const and = [];
    const q = String(req.query.q || '').trim().slice(0, 40);
    if (q) {
      const rx = new RegExp(escapeRegex(q), 'i');
      and.push({ $or: [{ code: rx }, { name: rx }] });
    }
    if (req.query.dieticianId && isId(req.query.dieticianId)) and.push({ dieticianId: req.query.dieticianId });
    const now = new Date();
    if (req.query.status === 'live') and.push({ isActive: true, validTill: { $gte: now } });
    if (req.query.status === 'expired') and.push({ validTill: { $lt: now } });
    if (req.query.status === 'inactive') and.push({ isActive: false });
    const filter = and.length ? { $and: and } : {};

    const [rows, total] = await Promise.all([
      Coupon.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      Coupon.countDocuments(filter),
    ]);
    const owners = await User.find({ _id: { $in: rows.map((r) => r.dieticianId) } }).select('profile.fullName').lean();
    const name = new Map(owners.map((o) => [String(o._id), o.profile?.fullName || '']));
    res.json({
      success: true,
      data: { items: rows.map((c) => ({ ...c, dieticianName: name.get(String(c.dieticianId)) || '', status: status(c) })), total, page, limit },
    });
  } catch (err) {
    next(err);
  }
};

// POST /api/admin/coupons  { dieticianId, name, code, discountPercentage, validTill }
exports.create = async (req, res, next) => {
  try {
    const d = parseFields(req.body || {});
    const err = validate(d);
    if (err) return bad(res, err);
    if (!isId(req.body?.dieticianId)) return bad(res, 'Choose the dietician this coupon belongs to');
    const owner = await User.findOne({ _id: req.body.dieticianId, role: 'dietician' }).select('_id').lean();
    if (!owner) return bad(res, 'That dietician was not found');
    // Patients redeem by code alone, so a code must be unique across all dieticians.
    if (await Coupon.exists({ code: d.code })) return res.status(409).json({ success: false, message: 'A coupon with this code already exists' });

    const coupon = new Coupon({ ...d, dieticianId: owner._id, isActive: d.isActive ?? true });
    await audited(req, { action: 'coupon.create', targetType: 'coupon', targetId: String(coupon._id), after: { ...d, dieticianId: String(owner._id) } }, () => coupon.save());
    res.status(201).json({ success: true, data: { ...coupon.toObject(), status: status(coupon) } });
  } catch (err) {
    next(err);
  }
};

// PUT /api/admin/coupons/:id  (code and owner cannot change once created)
exports.update = async (req, res, next) => {
  try {
    if (!isId(req.params.id)) return bad(res, 'Invalid coupon id');
    const coupon = await Coupon.findById(req.params.id);
    if (!coupon) return res.status(404).json({ success: false, message: 'Coupon not found' });
    const d = parseFields({ ...req.body, code: undefined }, { partial: true });
    delete d.code;
    const err = validate(d, { partial: true });
    if (err) return bad(res, err);
    const before = { name: coupon.name, discountPercentage: coupon.discountPercentage, validTill: coupon.validTill, isActive: coupon.isActive };
    await audited(req, { action: 'coupon.update', targetType: 'coupon', targetId: String(coupon._id), before, after: d }, async () => {
      coupon.set(d);
      await coupon.save();
    });
    res.json({ success: true, data: { ...coupon.toObject(), status: status(coupon) } });
  } catch (err) {
    next(err);
  }
};
