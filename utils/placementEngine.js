const Recipe = require('../models/Recipe');
const ProductPlacement = require('../models/ProductPlacement');
const AdminAuditLog = require('../models/AdminAuditLog');
const { dueAction } = require('./placementRules');

/**
 * Puts a placement's image on every linked catalog entry. Only `image`,
 * `imageSource` and `sponsoredLabel` are touched: nutrition, ingredients and
 * instructions are never changed (openspec: admin-product-placements).
 *
 * Idempotent: the entry's previous image is recorded once, the first time.
 */
async function activatePlacement(placement, now = new Date()) {
  const previous = { ...(placement.previousImages || {}) };
  for (const recipeId of placement.recipeIds) {
    const id = String(recipeId);
    const recipe = await Recipe.findById(id).select('image imageSource').lean();
    if (!recipe) continue;
    if (!(id in previous)) {
      previous[id] = { image: recipe.image || null, imageSource: recipe.imageSource || null };
    }
    await Recipe.updateOne(
      { _id: id },
      { $set: { image: placement.image.url, imageSource: 'commercial', sponsoredLabel: placement.disclosure } }
    );
  }
  placement.previousImages = previous;
  placement.markModified('previousImages');
  placement.status = 'active';
  placement.activatedAt = placement.activatedAt || now;
  await placement.save();
  return placement;
}

/**
 * Gives each linked entry back the image it had before the placement.
 * An entry is only restored if it still shows this placement's image, so a
 * newer image set by someone else is never overwritten.
 */
async function restorePlacement(placement) {
  const previous = placement.previousImages || {};
  for (const [id, before] of Object.entries(previous)) {
    const recipe = await Recipe.findById(id).select('image imageSource').lean();
    if (!recipe) continue;
    if (recipe.imageSource !== 'commercial' || recipe.image !== placement.image?.url) continue;
    const set = {};
    const unset = { sponsoredLabel: '' };
    if (before.image) {
      set.image = before.image;
      if (before.imageSource) set.imageSource = before.imageSource;
      else unset.imageSource = '';
    } else {
      unset.image = '';
      unset.imageSource = '';
    }
    const update = { $unset: unset };
    if (Object.keys(set).length) update.$set = set;
    await Recipe.updateOne({ _id: id }, update);
  }
}

/** Ends a placement: restores images and records why. */
async function endPlacement(placement, status, reason, now = new Date()) {
  await restorePlacement(placement);
  placement.status = status;
  placement.endedAt = now;
  placement.endReason = reason;
  placement.pendingChange = undefined;
  await placement.save();
  return placement;
}

/**
 * Cron sweep (every ~10 minutes): starts scheduled placements whose start has
 * arrived and expires active ones whose end has passed. Safe to run often and
 * concurrently: every step is idempotent.
 */
async function runPlacementSweep(now = new Date()) {
  const candidates = await ProductPlacement.find({ status: { $in: ['scheduled', 'active'] } });
  const result = { activated: 0, expired: 0, errors: 0 };
  for (const p of candidates) {
    const action = dueAction(p, now);
    if (!action) continue;
    try {
      if (action === 'activate') {
        await activatePlacement(p, now);
        result.activated += 1;
        await AdminAuditLog.create({
          action: 'placement.activate',
          targetType: 'placement',
          targetId: String(p._id),
          actorEmail: 'system',
          meta: { productName: p.productName, recipeIds: p.recipeIds.map(String) },
        });
      } else {
        await endPlacement(p, 'expired', 'end_date_reached', now);
        result.expired += 1;
        await AdminAuditLog.create({
          action: 'placement.expire',
          targetType: 'placement',
          targetId: String(p._id),
          actorEmail: 'system',
          meta: { productName: p.productName },
        });
      }
    } catch (err) {
      result.errors += 1;
      console.error('placement sweep failed for', String(p._id), err.message);
    }
  }
  return result;
}

module.exports = { activatePlacement, restorePlacement, endPlacement, runPlacementSweep };
