const mongoose = require('mongoose');

// A shared, per-dietician ingredient record - primarily so an image fetched
// once for e.g. "Onion" is reused across every recipe that uses "Onion",
// instead of each recipe's embedded ingredient fetching its own independently.
// Deliberately does NOT replace Recipe.ingredients (the embedded array stays
// exactly as-is, order/shape untouched) - see utils/ingredientLibrary.js for
// why: translations are matched by array index, not by ingredient identity.
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
  },
  {
    timestamps: true,
  }
);

ingredientSchema.index({ dieticianId: 1, normalizedName: 1 }, { unique: true });

module.exports = mongoose.model('Ingredient', ingredientSchema);
