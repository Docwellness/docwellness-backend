const mongoose = require('mongoose');

/** Manufacturer / brand record for product placements (openspec: admin-product-placements). */
const BrandSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    legalName: { type: String, required: true, trim: true },
    contactName: { type: String, trim: true },
    phone: { type: String, trim: true },
    email: { type: String, trim: true, lowercase: true },
    gstin: { type: String, trim: true, uppercase: true },
    // Food / supplement licence number (e.g. FSSAI). Required before a
    // placement can be approved.
    licenceNumber: { type: String, trim: true },
    notes: { type: String },
    createdBy: { type: String },
  },
  { timestamps: true }
);

BrandSchema.index({ name: 1 });

module.exports = mongoose.models.Brand || mongoose.model('Brand', BrandSchema);
