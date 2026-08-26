/**
 * Read-only: looks up a dietician User by email OR by _id (auto-detected -
 * a 24-hex-char argument is treated as an _id, anything else as an email)
 * and prints its _id/email/role/profile.fullName. Exists so a Coolify
 * one-off command (or a terminal command anywhere) can look this up without
 * pasting a long inline node -e one-liner (Coolify's Scheduled Tasks
 * command field is a varchar(255) column and truncates/errors on anything
 * longer - use the Terminal tab instead of Scheduled Tasks for one-off
 * commands like this one).
 *
 * The _id lookup exists because dev/prod document _ids are meant to mirror
 * each other (prod was originally cloned from the same Atlas cluster dev
 * still uses - see docs/db-migration-oracle.md) - so a dietician's dev _id
 * is the most reliable way to find the same real person on prod, even if
 * their stored email/role fields turn out to differ between the two.
 *
 * Usage:
 *   node scripts/lookup-dietician-id.js someone@example.com
 *   node scripts/lookup-dietician-id.js 6a5e0c3619fa51068811c304
 */
require('dotenv').config();
const connectDB = require('../config/database');
const mongoose = require('mongoose');

const arg = process.argv[2];
if (!arg) {
  console.error('Usage: node scripts/lookup-dietician-id.js <email-or-_id>');
  process.exit(1);
}
const isId = /^[0-9a-fA-F]{24}$/.test(arg);

async function main() {
  await connectDB();
  try {
    const { User } = require('../models');
    const user = isId ? await User.findById(arg) : await User.findOne({ email: arg, role: 'dietician' });
    if (!user) {
      console.log('NOT FOUND');
      return;
    }
    console.log('_id:', user._id.toString());
    console.log('email:', user.email);
    console.log('role:', user.role);
    console.log('profile.fullName:', user.profile?.fullName);
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
