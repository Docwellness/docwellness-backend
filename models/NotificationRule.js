const mongoose = require('mongoose');

/**
 * Admin overrides for an automated notification. Absence of a row means "send
 * the shipped default" (see utils/notificationRules.js), so a fresh database
 * behaves exactly as before this model existed.
 */
const notificationRuleSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, trim: true },
    enabled: { type: Boolean, default: true },
    // Unset means "use the default".
    title: { type: String, trim: true },
    message: { type: String, trim: true },
    pushBody: { type: String, trim: true },
    updatedByEmail: { type: String, trim: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model('NotificationRule', notificationRuleSchema);
