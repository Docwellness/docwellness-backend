const mongoose = require('mongoose');

// A shared, per-dietician canonical ingredient record. Originally just an
// image cache (so a photo fetched once for e.g. "Onion" is reused across
// every recipe that uses "Onion"), now doubles as the canonical ingredient
// registry that scripts/migrate-canonical-ingredients.js populates and
// getGroceriesForCurrentWeek reads - one row per real-world ingredient per
// dietician, not per spelling variant. Deliberately does NOT replace
// Recipe.ingredients (the embedded array stays exactly as-is, order/shape
// untouched) - see utils/ingredientLibrary.js for why: translations are
// matched by array index, not by ingredient identity.
const ingredientSchema = new mongoose.Schema(
  {
    dieticianId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    // trim+lowercase form of `name`, used for lookup/uniqueness so "Onion"
    // and "onion" resolve to the same shared record.
    normalizedName: {
      type: String,
      required: true,
    },
    image: {
      type: String,
    },
    category: {
      type: String,
    },
    // Every raw-string variant recipes have used for this ingredient
    // (normalized at write time) - populated by scripts/migrate-canonical-
    // ingredients.js, consulted defensively so a future recipe using a new
    // spelling can still be recognized without another full migration.
    aliases: {
      type: [String],
      default: [],
    },
    // Grams-per-1-unit reference weight, keyed by the same units
    // Recipe.ingredients.unit uses. Not every key is present for every
    // ingredient (e.g. Turmeric Powder has no `piece`). Approximate,
    // standard culinary/USDA-style average values - see
    // scripts/canonical-ingredients-data.js for sourcing notes. Used by
    // getGroceriesForCurrentWeek to sum quantities recorded in different
    // units for the same ingredient.
    unitConversions: {
      g: { type: Number },
      ml: { type: Number },
      cup: { type: Number },
      tbsp: { type: Number },
      tsp: { type: Number },
      piece: { type: Number },
    },
    // Short natural-language quantity hint (e.g. "medium onion") used to
    // build the grocery list's friendly display string alongside the
    // precise base-unit total, e.g. "330g (~3 medium onion)".
    friendlyUnitLabel: {
      type: String,
    },
  },
  {
    timestamps: true,
  }
);

ingredientSchema.index({ dieticianId: 1, normalizedName: 1 }, { unique: true });

module.exports = mongoose.model('Ingredient', ingredientSchema);
