const mongoose = require('mongoose');

/**
 * Append-only record of admin-panel activity (openspec: admin-audit-log).
 * There is deliberately no update/delete code path anywhere in the app: the
 * hooks below also refuse them at the model level so a future controller
 * cannot alter history by accident.
 */
const AdminAuditLogSchema = new mongoose.Schema(
  {
    actorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    actorEmail: { type: String, lowercase: true, trim: true },
    action: { type: String, required: true, index: true },
    outcome: { type: String, enum: ['success', 'denied', 'failed', 'attempted'], default: 'success' },
    targetType: { type: String, index: true },
    targetId: { type: String, index: true },
    before: { type: mongoose.Schema.Types.Mixed },
    after: { type: mongoose.Schema.Types.Mixed },
    reason: { type: String },
    ip: { type: String },
    userAgent: { type: String },
    requestId: { type: String },
    meta: { type: mongoose.Schema.Types.Mixed },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

AdminAuditLogSchema.index({ createdAt: -1 });

const blocked = function () {
  throw new Error('AdminAuditLog is append-only');
};
[
  'updateOne',
  'updateMany',
  'findOneAndUpdate',
  'findOneAndDelete',
  'findOneAndReplace',
  'deleteOne',
  'deleteMany',
  'replaceOne',
].forEach((op) => AdminAuditLogSchema.pre(op, blocked));
// Mongoose 9 hooks take no `next` callback: throwing rejects the operation.
AdminAuditLogSchema.pre('save', function () {
  if (!this.isNew) throw new Error('AdminAuditLog is append-only');
});

module.exports = mongoose.models.AdminAuditLog || mongoose.model('AdminAuditLog', AdminAuditLogSchema);
