const mongoose = require('mongoose');

/**
 * A commercial partnering enquiry from a manufacturer or brand
 * (openspec: admin-partner-requests). Stage, discard and the reason for either
 * are separate fields on purpose, so "where is it" and "why did it end" can be
 * reported independently.
 */
const STAGES = ['new', 'qualified', 'proposal', 'negotiation', 'won', 'lost'];
const CATEGORIES = ['supplement', 'food', 'equipment', 'other'];
const SOURCES = ['referral', 'inbound_email', 'event', 'outreach', 'website', 'other'];
const LOST_REASONS = ['price', 'chose_competitor', 'timing', 'no_response', 'not_a_fit', 'compliance'];
const UNQUALIFIED_REASONS = ['duplicate', 'spam', 'out_of_scope', 'no_licence', 'not_a_real_company'];

const PartnerRequestSchema = new mongoose.Schema(
  {
    company: { type: String, required: true, trim: true },
    contactName: { type: String, required: true, trim: true },
    phone: { type: String, trim: true },
    email: { type: String, trim: true, lowercase: true },
    category: { type: String, enum: CATEGORIES, default: 'supplement' },
    products: { type: String, trim: true },
    budgetRange: { type: String, trim: true },
    source: { type: String, enum: SOURCES, default: 'other' },
    owner: { type: String, trim: true },
    expectedValue: { type: Number, min: 0, default: 0 },
    expectedCloseAt: { type: Date },

    stage: { type: String, enum: STAGES, default: 'new', index: true },
    // Set when the stage is "lost" (LOST_REASONS) or the request is discarded (UNQUALIFIED_REASONS).
    closeReason: { type: String },
    discarded: { type: Boolean, default: false, index: true },

    stageHistory: [
      {
        _id: false,
        from: String,
        to: String,
        at: { type: Date, default: Date.now },
        by: String,
        reason: String,
      },
    ],
    // Append-only: there is no update or delete route for notes.
    notes: [
      {
        text: { type: String, required: true, trim: true, maxlength: 2000 },
        at: { type: Date, default: Date.now },
        by: String,
      },
    ],
    attachments: [
      {
        name: String,
        publicId: String,
        resourceType: String,
        format: String,
        mime: String,
        bytes: Number,
        uploadedAt: { type: Date, default: Date.now },
        uploadedBy: String,
      },
    ],

    // Set once a Brand has been created from this request (won -> placement).
    brandId: { type: mongoose.Schema.Types.ObjectId, ref: 'Brand' },
    createdBy: String,
  },
  { timestamps: true }
);

PartnerRequestSchema.index({ createdAt: -1 });
PartnerRequestSchema.index({ company: 1 });

const Model = mongoose.models.PartnerRequest || mongoose.model('PartnerRequest', PartnerRequestSchema);
Model.STAGES = STAGES;
Model.CATEGORIES = CATEGORIES;
Model.SOURCES = SOURCES;
Model.LOST_REASONS = LOST_REASONS;
Model.UNQUALIFIED_REASONS = UNQUALIFIED_REASONS;
module.exports = Model;
