const mongoose = require('mongoose');

// Lightweight, additive audit trail for every AI generation call (recipe or
// diet plan) - inputHash/model/latency/validator warnings, so generations are
// reproducible and reviewable later. Nothing reads this yet; it exists so
// future observability/eval work (golden-dataset regression, drift tracking)
// has real data to build on instead of starting from zero.
const generationLogSchema = new mongoose.Schema(
  {
    kind: {
      type: String,
      enum: ['recipe', 'dietPlan'],
      required: true,
    },
    dieticianId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    refId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
    },
    model: {
      type: String,
    },
    promptVersion: {
      type: String,
      default: null,
    },
    inputHash: {
      type: String,
      default: null,
    },
    latencyMs: {
      type: Number,
      default: null,
    },
    validatorWarnings: {
      type: [String],
      default: [],
    },
    succeeded: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model('GenerationLog', generationLogSchema);
