// Pagination helper matching the shape most controllers already hand-roll
// inline (e.g. dietPlanController.js, chatController.js, mealLogController.js
// - {page, limit, total, hasMore}, with page/limit clamped and parsed the
// same way in each). This is a NEW, additive utility for new/migrated
// controllers to use instead of repeating that boilerplate - existing
// controllers' own inline pagination logic is untouched.

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/**
 * Parses & clamps ?page=&limit= from req.query.
 * @returns {{ page: number, limit: number, skip: number }}
 */
function parsePagination(query = {}, { defaultLimit = DEFAULT_LIMIT, maxLimit = MAX_LIMIT } = {}) {
  const pageNum = Math.max(parseInt(query.page, 10) || 1, 1);
  const limitParsed = parseInt(query.limit, 10);
  const limitNum = Math.min(Math.max(Number.isNaN(limitParsed) ? defaultLimit : limitParsed, 1), maxLimit);
  const skip = (pageNum - 1) * limitNum;
  return { page: pageNum, limit: limitNum, skip };
}

/**
 * @param {{ page: number, limit: number, total: number, resultCount?: number }} args
 *   resultCount defaults to `limit` (the common case: a full page was
 *   returned) - pass the actual returned array's length when the last page
 *   is short, so hasMore is computed correctly (skip + resultCount < total)
 *   rather than assuming a full page.
 * @returns {{ page: number, limit: number, total: number, hasMore: boolean }}
 */
function buildPaginationMeta({ page, limit, total, resultCount }) {
  const skip = (page - 1) * limit;
  const count = resultCount ?? limit;
  return { page, limit, total, hasMore: skip + count < total };
}

module.exports = { parsePagination, buildPaginationMeta, DEFAULT_LIMIT, MAX_LIMIT };
