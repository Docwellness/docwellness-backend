const mongoose = require('mongoose');

const ImageSchema = new mongoose.Schema(
  {
    url: String,
    publicId: String,
    alt: String,
    width: Number,
    height: Number,
  },
  { _id: false }
);

/**
 * A purchased, time-bound commercial product image on one or more catalog
 * entries (openspec: admin-product-placements).
 *
 * Statuses: draft -> pending_approval -> scheduled (approved, waiting for its
 * start date) -> active -> expired | cancelled.
 * Editing an approved placement never touches what is live: the edit is held
 * in `pendingChange` until it is approved again.
 */
const ProductPlacementSchema = new mongoose.Schema(
  {
    brandId: { type: mongoose.Schema.Types.ObjectId, ref: 'Brand', required: true, index: true },
    productName: { type: String, required: true, trim: true },
    sku: { type: String, trim: true },
    recipeIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Recipe' }],
    image: ImageSchema,
    disclosure: { type: String, default: 'Sponsored', trim: true },
    startsAt: { type: Date, required: true },
    endsAt: { type: Date, required: true },

    // Commercial terms: a simple fee over the dates above.
    fee: { type: Number, min: 0, default: 0 },
    invoiceRef: { type: String, trim: true },
    feeReceivedAt: { type: Date },

    status: {
      type: String,
      enum: ['draft', 'pending_approval', 'scheduled', 'active', 'expired', 'cancelled'],
      default: 'draft',
      index: true,
    },
    checklist: {
      licenceRecorded: Boolean,
      noHealthClaims: Boolean,
      by: String,
      at: Date,
    },
    approvedBy: String,
    approvedAt: Date,
    activatedAt: Date,
    endedAt: Date,
    endReason: String,

    // What each linked entry showed before this placement took over, keyed by
    // recipe id. Used to restore on expiry or cancel.
    previousImages: { type: mongoose.Schema.Types.Mixed, default: {} },

    // An edit made after approval, waiting for re-approval. The approved
    // version stays live in the meantime.
    pendingChange: { type: mongoose.Schema.Types.Mixed },

    createdBy: String,
  },
  { timestamps: true }
);

ProductPlacementSchema.index({ status: 1, startsAt: 1, endsAt: 1 });
ProductPlacementSchema.index({ recipeIds: 1 });

module.exports =
  mongoose.models.ProductPlacement || mongoose.model('ProductPlacement', ProductPlacementSchema);
