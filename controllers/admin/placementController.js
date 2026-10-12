const fs = require('fs');
const mongoose = require('mongoose');
const cloudinary = require('../../config/cloudinary');
const Brand = require('../../models/Brand');
const ProductPlacement = require('../../models/ProductPlacement');
const Recipe = require('../../models/Recipe');
const { audited } = require('../../utils/adminAudit');
const {
  validateDates,
  validateImageFile,
  findOverlap,
  approvalBlockers,
} = require('../../utils/placementRules');
const { activatePlacement, restorePlacement, endPlacement } = require('../../utils/placementEngine');

const isId = (v) => mongoose.Types.ObjectId.isValid(String(v));
const bad = (res, message, extra = {}) => res.status(400).json({ success: false, message, ...extra });
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Fields an admin may set. `LIVE_FIELDS` change what users see, so on an
// approved placement they wait for re-approval; the rest apply straight away.
const LIVE_FIELDS = ['productName', 'sku', 'recipeIds', 'disclosure', 'startsAt', 'endsAt'];
const DIRECT_FIELDS = ['fee', 'invoiceRef', 'feeReceivedAt'];

function pickFields(body, names) {
  const out = {};
  for (const n of names) if (body[n] !== undefined) out[n] = body[n];
  return out;
}

async function loadRecipes(ids) {
  if (!ids.length) return [];
  const rows = await Recipe.find({ _id: { $in: ids } })
    .select('name category image imageSource')
    .lean();
  const byId = new Map(rows.map((r) => [String(r._id), r]));
  return ids.map((id) => byId.get(String(id))).filter(Boolean);
}

async function checkRecipes(ids) {
  if (!Array.isArray(ids) || ids.length === 0) return 'Link at least one entry';
  if (ids.some((i) => !isId(i))) return 'One of the linked entries is invalid';
  const unique = [...new Set(ids.map(String))];
  const found = await Recipe.countDocuments({ _id: { $in: unique } });
  if (found !== unique.length) return 'One of the linked entries does not exist';
  return null;
}

// ---------- Brands ----------

exports.listBrands = async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim();
    const filter = q ? { name: new RegExp(escapeRegex(q.slice(0, 80)), 'i') } : {};
    const brands = await Brand.find(filter).sort({ name: 1 }).limit(200).lean();
    res.json({ success: true, data: brands });
  } catch (err) {
    next(err);
  }
};

function brandFields(body) {
  return pickFields(body, ['name', 'legalName', 'contactName', 'phone', 'email', 'gstin', 'licenceNumber', 'notes']);
}

function brandError(b) {
  if (!b.name || !String(b.name).trim()) return 'Brand name is required';
  if (!b.legalName || !String(b.legalName).trim()) return 'Legal entity name is required';
  if (!b.phone && !b.email) return 'Add a phone number or an email';
  return null;
}

exports.createBrand = async (req, res, next) => {
  try {
    const data = brandFields(req.body);
    const err = brandError(data);
    if (err) return bad(res, err);
    const brand = new Brand({ ...data, createdBy: req.admin.email });
    await audited(
      req,
      { action: 'brand.create', targetType: 'brand', targetId: String(brand._id), after: data },
      () => brand.save()
    );
    res.status(201).json({ success: true, data: brand });
  } catch (err) {
    next(err);
  }
};

exports.updateBrand = async (req, res, next) => {
  try {
    const brand = await Brand.findById(req.params.id);
    if (!brand) return res.status(404).json({ success: false, message: 'Brand not found' });
    const data = brandFields(req.body);
    const merged = { ...brand.toObject(), ...data };
    const err = brandError(merged);
    if (err) return bad(res, err);
    const before = brandFields(brand.toObject());
    await audited(
      req,
      { action: 'brand.update', targetType: 'brand', targetId: String(brand._id), before, after: data },
      async () => {
        brand.set(data);
        await brand.save();
      }
    );
    res.json({ success: true, data: brand });
  } catch (err) {
    next(err);
  }
};

// ---------- Placements ----------

async function present(placement) {
  const p = placement.toObject ? placement.toObject() : placement;
  const brand = await Brand.findById(p.brandId).lean();
  const recipes = await loadRecipes(p.recipeIds || []);
  const pendingRecipes = p.pendingChange?.recipeIds ? await loadRecipes(p.pendingChange.recipeIds) : undefined;
  return { ...p, brand, recipes, pendingRecipes };
}

exports.listPlacements = async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 25));
    const filter = {};
    if (req.query.status) filter.status = req.query.status;
    if (req.query.brandId && isId(req.query.brandId)) filter.brandId = req.query.brandId;
    if (req.query.q) filter.productName = new RegExp(escapeRegex(String(req.query.q).slice(0, 80)), 'i');

    const [rows, total] = await Promise.all([
      ProductPlacement.find(filter)
        .sort({ updatedAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      ProductPlacement.countDocuments(filter),
    ]);
    const brands = await Brand.find({ _id: { $in: rows.map((r) => r.brandId) } })
      .select('name')
      .lean();
    const brandName = new Map(brands.map((b) => [String(b._id), b.name]));
    const items = rows.map((r) => ({
      _id: r._id,
      productName: r.productName,
      sku: r.sku,
      brandName: brandName.get(String(r.brandId)) || '',
      status: r.status,
      startsAt: r.startsAt,
      endsAt: r.endsAt,
      fee: r.fee,
      feeReceivedAt: r.feeReceivedAt,
      entries: (r.recipeIds || []).length,
      hasPendingChange: Boolean(r.pendingChange),
      image: r.image?.url || null,
    }));
    res.json({ success: true, data: { items, total, page, limit } });
  } catch (err) {
    next(err);
  }
};

exports.getPlacement = async (req, res, next) => {
  try {
    const p = await ProductPlacement.findById(req.params.id);
    if (!p) return res.status(404).json({ success: false, message: 'Placement not found' });
    res.json({ success: true, data: await present(p) });
  } catch (err) {
    next(err);
  }
};

exports.createPlacement = async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!isId(b.brandId) || !(await Brand.exists({ _id: b.brandId }))) return bad(res, 'Choose a brand');
    if (!b.productName || !String(b.productName).trim()) return bad(res, 'Product name is required');
    const dateErr = validateDates(b.startsAt, b.endsAt);
    if (dateErr) return bad(res, dateErr);
    const recipeErr = await checkRecipes(b.recipeIds);
    if (recipeErr) return bad(res, recipeErr);
    const fee = b.fee === undefined || b.fee === '' ? 0 : Number(b.fee);
    if (!Number.isFinite(fee) || fee < 0) return bad(res, 'The fee must be zero or more');

    const placement = new ProductPlacement({
      brandId: b.brandId,
      ...pickFields(b, ['productName', 'sku', 'disclosure', 'startsAt', 'endsAt', 'invoiceRef']),
      recipeIds: [...new Set(b.recipeIds.map(String))],
      fee,
      createdBy: req.admin.email,
    });
    await audited(
      req,
      {
        action: 'placement.create',
        targetType: 'placement',
        targetId: String(placement._id),
        after: { productName: placement.productName, brandId: b.brandId, startsAt: b.startsAt, endsAt: b.endsAt, fee },
      },
      () => placement.save()
    );
    res.status(201).json({ success: true, data: await present(placement) });
  } catch (err) {
    next(err);
  }
};

exports.updatePlacement = async (req, res, next) => {
  try {
    const p = await ProductPlacement.findById(req.params.id);
    if (!p) return res.status(404).json({ success: false, message: 'Placement not found' });
    if (['expired', 'cancelled'].includes(p.status)) {
      return res.status(409).json({ success: false, message: `A ${p.status} placement cannot be edited` });
    }
    const body = req.body || {};
    const live = pickFields(body, LIVE_FIELDS);
    const direct = pickFields(body, DIRECT_FIELDS);

    const effective = { ...p.toObject(), ...(p.pendingChange || {}), ...live };
    if (live.startsAt !== undefined || live.endsAt !== undefined) {
      const dateErr = validateDates(effective.startsAt, effective.endsAt);
      if (dateErr) return bad(res, dateErr);
    }
    if (live.recipeIds !== undefined) {
      const recipeErr = await checkRecipes(live.recipeIds);
      if (recipeErr) return bad(res, recipeErr);
      live.recipeIds = [...new Set(live.recipeIds.map(String))];
    }
    if (live.productName !== undefined && !String(live.productName).trim()) return bad(res, 'Product name is required');
    if (direct.fee !== undefined) {
      direct.fee = Number(direct.fee);
      if (!Number.isFinite(direct.fee) || direct.fee < 0) return bad(res, 'The fee must be zero or more');
    }
    if (direct.feeReceivedAt === '') direct.feeReceivedAt = null;

    const approved = ['scheduled', 'active'].includes(p.status);
    const before = { ...pickFields(p.toObject(), [...LIVE_FIELDS, ...DIRECT_FIELDS]) };

    await audited(
      req,
      {
        action: approved && Object.keys(live).length ? 'placement.edit_pending' : 'placement.update',
        targetType: 'placement',
        targetId: String(p._id),
        before,
        after: { ...live, ...direct },
      },
      async () => {
        if (direct && Object.keys(direct).length) p.set(direct);
        if (Object.keys(live).length) {
          if (approved) {
            // The approved version stays live; this waits for re-approval.
            p.pendingChange = { ...(p.pendingChange || {}), ...live };
            p.markModified('pendingChange');
          } else {
            p.set(live);
            if (p.status === 'pending_approval') p.status = 'draft';
          }
        }
        await p.save();
      }
    );
    res.json({ success: true, data: await present(p) });
  } catch (err) {
    next(err);
  }
};

exports.uploadImage = async (req, res, next) => {
  const tmp = req.file?.path;
  try {
    const p = await ProductPlacement.findById(req.params.id);
    if (!p) return res.status(404).json({ success: false, message: 'Placement not found' });
    if (['expired', 'cancelled'].includes(p.status)) {
      return res.status(409).json({ success: false, message: `A ${p.status} placement cannot be edited` });
    }
    const alt = String(req.body?.alt || '').trim();
    if (!alt) return bad(res, 'Alt text is required for the image');
    const fileErr = validateImageFile(req.file);
    if (fileErr) return bad(res, fileErr);

    const up = await cloudinary.uploader.upload(req.file.path, {
      folder: `docwellness/admin/placements/${p._id}`,
    });
    const dimErr = validateImageFile(req.file, { width: up.width, height: up.height });
    if (dimErr) {
      await cloudinary.uploader.destroy(up.public_id).catch(() => {});
      return bad(res, dimErr);
    }
    const image = {
      url: up.secure_url || up.url,
      publicId: up.public_id,
      alt,
      width: up.width,
      height: up.height,
    };
    const approved = ['scheduled', 'active'].includes(p.status);

    await audited(
      req,
      {
        action: approved ? 'placement.image_pending' : 'placement.image_set',
        targetType: 'placement',
        targetId: String(p._id),
        before: { image: p.image?.url || null },
        after: { image: image.url, alt },
      },
      async () => {
        if (approved) {
          p.pendingChange = { ...(p.pendingChange || {}), image };
          p.markModified('pendingChange');
        } else {
          p.image = image;
          if (p.status === 'pending_approval') p.status = 'draft';
        }
        await p.save();
      }
    );
    res.json({ success: true, data: await present(p) });
  } catch (err) {
    next(err);
  } finally {
    if (tmp) fs.unlink(tmp, () => {});
  }
};

exports.submitPlacement = async (req, res, next) => {
  try {
    const p = await ProductPlacement.findById(req.params.id);
    if (!p) return res.status(404).json({ success: false, message: 'Placement not found' });
    if (p.status !== 'draft') return res.status(409).json({ success: false, message: 'Only a draft can be submitted' });
    const brand = await Brand.findById(p.brandId).lean();
    const missing = approvalBlockers(p, brand, { licenceRecorded: true, noHealthClaims: true }).filter(
      (m) => !m.startsWith('Manufacturer licence')
    );
    if (missing.length) return bad(res, 'The placement is not complete yet', { missing });
    await audited(
      req,
      { action: 'placement.submit', targetType: 'placement', targetId: String(p._id), before: { status: 'draft' }, after: { status: 'pending_approval' } },
      async () => {
        p.status = 'pending_approval';
        await p.save();
      }
    );
    res.json({ success: true, data: await present(p) });
  } catch (err) {
    next(err);
  }
};

exports.approvePlacement = async (req, res, next) => {
  try {
    const p = await ProductPlacement.findById(req.params.id);
    if (!p) return res.status(404).json({ success: false, message: 'Placement not found' });
    const isReapproval = ['scheduled', 'active'].includes(p.status) && p.pendingChange;
    if (p.status !== 'pending_approval' && !isReapproval) {
      return res.status(409).json({ success: false, message: 'There is nothing waiting for approval' });
    }

    const checklist = {
      licenceRecorded: Boolean(req.body?.checklist?.licenceRecorded),
      noHealthClaims: Boolean(req.body?.checklist?.noHealthClaims),
    };
    const effective = { ...p.toObject(), ...(p.pendingChange || {}) };
    const brand = await Brand.findById(p.brandId).lean();
    const missing = approvalBlockers(effective, brand, checklist);
    if (missing.length) return bad(res, 'Approval is not possible yet', { missing });

    const live = await ProductPlacement.find({
      status: { $in: ['scheduled', 'active'] },
      _id: { $ne: p._id },
      recipeIds: { $in: effective.recipeIds },
    }).lean();
    const clash = findOverlap(effective, live);
    if (clash) {
      const name = (await Recipe.findById(clash.recipeId).select('name').lean())?.name || clash.recipeId;
      return res.status(409).json({
        success: false,
        code: 'overlap',
        message: `"${name}" already has a placement in these dates: ${clash.placement.productName}`,
      });
    }

    const now = new Date();
    await audited(
      req,
      {
        action: isReapproval ? 'placement.reapprove' : 'placement.approve',
        targetType: 'placement',
        targetId: String(p._id),
        before: { status: p.status },
        after: { checklist },
      },
      async () => {
        if (isReapproval && p.status === 'active') {
          // Take the old version off before the new one goes on.
          await restorePlacement(p);
          p.previousImages = {};
        }
        if (p.pendingChange) {
          const { image, ...fields } = p.pendingChange;
          p.set(fields);
          if (image) p.image = image;
          p.pendingChange = undefined;
        }
        p.checklist = { ...checklist, by: req.admin.email, at: now };
        p.approvedBy = req.admin.email;
        p.approvedAt = now;
        p.status = 'scheduled';
        await p.save();
        if (new Date(p.startsAt) <= now && new Date(p.endsAt) > now) {
          await activatePlacement(p, now);
        }
      }
    );
    res.json({ success: true, data: await present(p) });
  } catch (err) {
    next(err);
  }
};

exports.cancelPlacement = async (req, res, next) => {
  try {
    const p = await ProductPlacement.findById(req.params.id);
    if (!p) return res.status(404).json({ success: false, message: 'Placement not found' });
    if (['expired', 'cancelled'].includes(p.status)) {
      return res.status(409).json({ success: false, message: `The placement is already ${p.status}` });
    }
    const reason = String(req.body?.reason || '').trim();
    if (!reason) return bad(res, 'A reason is required to cancel');
    await audited(
      req,
      {
        action: 'placement.cancel',
        targetType: 'placement',
        targetId: String(p._id),
        before: { status: p.status },
        after: { status: 'cancelled' },
        reason,
      },
      async () => {
        if (p.status === 'active') {
          await endPlacement(p, 'cancelled', reason);
        } else {
          p.status = 'cancelled';
          p.endedAt = new Date();
          p.endReason = reason;
          p.pendingChange = undefined;
          await p.save();
        }
      }
    );
    res.json({ success: true, data: await present(p) });
  } catch (err) {
    next(err);
  }
};
