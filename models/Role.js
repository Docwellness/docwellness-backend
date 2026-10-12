const mongoose = require('mongoose');

/**
 * Admin roles as data (openspec: admin-rbac-permissions). `permissions` maps
 * a resource to the allowed actions. Anything not listed is denied.
 */
const RoleSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true },
    description: String,
    permissions: { type: mongoose.Schema.Types.Mixed, default: {} },
    assignable: { type: Boolean, default: true },
  },
  { timestamps: true }
);

module.exports = mongoose.models.Role || mongoose.model('Role', RoleSchema);
