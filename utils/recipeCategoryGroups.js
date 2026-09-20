// The dietician app's "Recipes & Supplements" / Diet & Exercise tab offers
// every real Recipe.category value the dietician has recipes in as its own
// selectable top-level chip (see GET /recipes/categories), each expecting
// per-serving-time summary/grid behavior scoped to an exact category match.
// "Western" is kept as a legacy UI/query-level grouping over several
// existing category values (not a rename of them) for any caller that still
// passes it explicitly.

// Every category value NOT explicitly "Indian", "Continental", or
// "Supplements" that should surface under the "Western" bucket. Deliberately
// excludes the handful of specifically-Asian values (Asian, Japanese,
// Chinese, Thai, Korean, Middle Eastern) which don't fit "Western" - those
// only ever appear under "All" until a dedicated bucket is worth adding.
const WESTERN_CATEGORIES = [
  'American', 'British', 'French', 'Mediterranean', 'Italian', 'Mexican',
  'Fusion', 'Healthy Bowls', 'Smoothies & Drinks', 'Keto', 'Vegan Specials',
  'High Protein', 'Low Carb', 'Detox', 'Other', 'Western',
];

/**
 * Resolves a top-level category into a Mongo filter fragment to merge into
 * a Recipe query. Returns null for 'All' (no filtering). Any value that
 * isn't the legacy "Western" grouping falls back to an exact category
 * match, so every real Recipe.category value works as a topCategory.
 */
function resolveTopCategoryFilter(topCategory) {
  if (!topCategory || topCategory === 'All') return null;
  if (topCategory === 'Western') return { category: { $in: WESTERN_CATEGORIES } };
  return { category: topCategory };
}

/**
 * Combines a top-level category filter (from resolveTopCategoryFilter) with
 * a second, more specific category constraint - an exact category a caller
 * wants to require regardless of which top-level filter is active (e.g. the
 * Supplements shortcut card always means "category is exactly Supplements",
 * on top of whatever cuisine chip is selected). Recipe.category is a single
 * value, so this is an intersection, not an override: if the two constraints
 * disagree, no recipe can satisfy both and the result must match nothing.
 */
function intersectCategoryFilter(topCategoryFilter, exactCategory) {
  if (!exactCategory || exactCategory === 'All') return topCategoryFilter;
  if (!topCategoryFilter || !topCategoryFilter.category) return { category: exactCategory };
  const allowed = topCategoryFilter.category;
  const satisfiable = typeof allowed === 'string'
    ? allowed === exactCategory
    : Array.isArray(allowed.$in) && allowed.$in.includes(exactCategory);
  return { category: satisfiable ? exactCategory : { $in: [] } };
}

module.exports = { WESTERN_CATEGORIES, resolveTopCategoryFilter, intersectCategoryFilter };
