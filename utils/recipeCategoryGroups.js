// The "Recipes & Supplements" screen browses recipes through a simplified
// 4-bucket top-level grouping (All / Indian / Continental / Western /
// Supplements) layered ON TOP of the existing, unchanged 24-value
// Recipe.category enum - no data migration, no loss of the finer-grained
// categories (American, Detox, Keto, etc.), which stay exactly as stored.
// "Western" is a UI/query-level grouping over several existing category
// values, not a rename of them.

const TOP_CATEGORIES = ['All', 'Indian', 'Continental', 'Western', 'Supplements'];

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
 * Resolves a top-level category (one of TOP_CATEGORIES) into a Mongo filter
 * fragment to merge into a Recipe query. Returns null for 'All'/unrecognized
 * (no filtering).
 */
function resolveTopCategoryFilter(topCategory) {
  if (!topCategory || topCategory === 'All') return null;
  if (topCategory === 'Indian') return { category: 'Indian' };
  if (topCategory === 'Continental') return { category: 'Continental' };
  if (topCategory === 'Supplements') return { category: 'Supplements' };
  if (topCategory === 'Western') return { category: { $in: WESTERN_CATEGORIES } };
  return null;
}

module.exports = { TOP_CATEGORIES, WESTERN_CATEGORIES, resolveTopCategoryFilter };
