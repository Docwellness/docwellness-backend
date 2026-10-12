const mongoose = require('mongoose');

/**
 * Server-side view of an admin sign-in session (openspec: admin-auth-access).
 * Keyed by the Supabase session id carried in the access token, so idle and
 * absolute limits are enforced here and not only by token/cookie lifetime.
 */
const AdminSessionSchema = new mongoose.Schema(
  {
    sessionId: { type: String, required: true, unique: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    email: { type: String, lowercase: true },
    startedAt: { type: Date, default: Date.now },
    lastSeenAt: { type: Date, default: Date.now },
    revokedAt: { type: Date },
    revokedReason: { type: String },
    ip: String,
    userAgent: String,
  },
  { timestamps: true }
);

// Housekeeping only: drop session rows 7 days after they were last seen.
AdminSessionSchema.index({ lastSeenAt: 1 }, { expireAfterSeconds: 7 * 24 * 3600 });

module.exports = mongoose.models.AdminSession || mongoose.model('AdminSession', AdminSessionSchema);
