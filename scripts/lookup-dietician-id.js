/**
 * Read-only: prints a dietician User's _id by email. Exists so a Coolify
 * one-off command (or a terminal command anywhere) can look up an
 * environment's dietician _id without pasting a long inline node -e
 * one-liner (Coolify's Scheduled Tasks command field is a varchar(255)
 * column and truncates/errors on anything longer - use the Terminal tab
 * instead of Scheduled Tasks for one-off commands like this one).
 *
 * Usage:
 *   node scripts/lookup-dietician-id.js someone@example.com
 */
require('dotenv').config();
const connectDB = require('../config/database');
const mongoose = require('mongoose');

const email = process.argv[2];
if (!email) {
  console.error('Usage: node scripts/lookup-dietician-id.js <email>');
  process.exit(1);
}

async function main() {
  await connectDB();
  try {
    const { User } = require('../models');
    const user = await User.findOne({ email, role: 'dietician' });
    console.log(user ? user._id.toString() : 'NOT FOUND');
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
