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
      enum: ['recipe', 'dietPlan', 'exercise'],
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
    // Backend request id (req.id) - set on Laya shadow rows so they can be
    // matched to request logs; null on ordinary generation rows.
    requestId: {
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
    // Laya decision-log fields (see services/layaDecisionService.js) - all
    // additive/optional so existing recipe/dietPlan/exercise writes are
    // untouched. Decision metadata only, never PII/PHI. Nothing writes
    // these yet in Stage A; the schema is ready for Stage B's shadow-mode
    // wiring (see docs/laya-architecture.md).
    layaMode: {
      type: String,
      enum: ['off', 'shadow', 'live', null],
      default: null,
    },
    // Which decision a shadow row is for (services/layaShadowService.js).
    layaSurface: {
      type: String,
      default: null,
    },
    layaDecisions: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    layaLatencyMs: {
      type: Number,
      default: null,
    },
    layaConfidence: {
      type: Number,
      default: null,
    },
    layaTimedOut: {
      type: Boolean,
      default: false,
    },
    // Why a shadow call produced no answer: { reason: 'disabled'|'timeout'|
    // 'error'|'skipped', detail } - 'skipped' means the in-flight cap was hit
    // and Laya was not called. detail is a short string, never request text.
    layaError: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model('GenerationLog', generationLogSchema);
