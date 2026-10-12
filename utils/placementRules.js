/**
 * Pure validation helpers for product placements
 * (openspec: admin-product-placements). No I/O.
 */

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MIN_IMAGE_SIDE = 800;

/** @returns {string|null} an error message, or null when valid */
function validateDates(startsAt, endsAt) {
  const s = new Date(startsAt);
  const e = new Date(endsAt);
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) return 'Start and end dates are required';
  if (e.getTime() <= s.getTime()) return 'The end date must be after the start date';
  return null;
}

/** @param {{mimetype?: string, size?: number}} file  @param {{width?: number, height?: number}} [dims] */
function validateImageFile(file, dims) {
  if (!file) return 'An image file is required';
  if (!IMAGE_TYPES.includes(file.mimetype)) return 'The image must be a JPG, PNG or WebP';
  if (file.size > MAX_IMAGE_BYTES) return 'The image must be 10 MB or smaller';
  if (dims && (dims.width < MIN_IMAGE_SIDE || dims.height < MIN_IMAGE_SIDE)) {
    return `The image must be at least ${MIN_IMAGE_SIDE} x ${MIN_IMAGE_SIDE} pixels`;
  }
  return null;
}

/** Date-range overlap, treating ranges as half-open [start, end). */
function rangesOverlap(aStart, aEnd, bStart, bEnd) {
  return new Date(aStart) < new Date(bEnd) && new Date(bStart) < new Date(aEnd);
}

/**
 * Finds a live (scheduled/active) placement that shares a recipe and a date
 * range with the candidate.
 * @returns {{placement: object, recipeId: string}|null}
 */
function findOverlap(candidate, others) {
  const ids = new Set((candidate.recipeIds || []).map(String));
  for (const o of others) {
    if (String(o._id) === String(candidate._id)) continue;
    if (!['scheduled', 'active'].includes(o.status)) continue;
    if (!rangesOverlap(candidate.startsAt, candidate.endsAt, o.startsAt, o.endsAt)) continue;
    const shared = (o.recipeIds || []).map(String).find((r) => ids.has(r));
    if (shared) return { placement: o, recipeId: shared };
  }
  return null;
}

/** Everything that must be true before a placement may be approved. */
function approvalBlockers(placement, brand, checklist) {
  const missing = [];
  if (!brand) missing.push('Brand record');
  else if (!brand.licenceNumber) missing.push('Manufacturer licence number on the brand');
  if (!placement.productName) missing.push('Product name');
  if (!placement.image?.url) missing.push('Product image');
  else if (!placement.image.alt) missing.push('Image alt text');
  if (!placement.recipeIds || placement.recipeIds.length === 0) missing.push('At least one linked entry');
  if (!placement.disclosure || !String(placement.disclosure).trim()) missing.push('Sponsored disclosure label');
  if (!checklist?.licenceRecorded) missing.push('Checklist: licence number recorded');
  if (!checklist?.noHealthClaims) missing.push('Checklist: image makes no unapproved health claims');
  const dateError = validateDates(placement.startsAt, placement.endsAt);
  if (dateError) missing.push(dateError);
  return missing;
}

/** What the sweep should do for a placement at `now`. */
function dueAction(placement, now = new Date()) {
  const t = new Date(now).getTime();
  const start = new Date(placement.startsAt).getTime();
  const end = new Date(placement.endsAt).getTime();
  if (placement.status === 'scheduled') {
    if (end <= t) return 'expire_unstarted';
    if (start <= t) return 'activate';
  }
  if (placement.status === 'active' && end <= t) return 'expire';
  return null;
}

module.exports = {
  IMAGE_TYPES,
  MAX_IMAGE_BYTES,
  MIN_IMAGE_SIDE,
  validateDates,
  validateImageFile,
  rangesOverlap,
  findOverlap,
  approvalBlockers,
  dueAction,
};
