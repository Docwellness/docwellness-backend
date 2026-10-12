/**
 * Disclosure text for a recipe/supplement whose main image is a paid product
 * placement (openspec add-admin-panel: admin-product-placements).
 *
 * Returns null unless a commercial image is actually live, so a label can
 * never outlive its placement. Falls back to "Sponsored" so an image is never
 * shown as commercial without a disclosure.
 */
function sponsoredLabelOf(recipe) {
  if (!recipe || recipe.imageSource !== 'commercial') return null;
  const label = typeof recipe.sponsoredLabel === 'string' ? recipe.sponsoredLabel.trim() : '';
  return label || 'Sponsored';
}

module.exports = { sponsoredLabelOf };
