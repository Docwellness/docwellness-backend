/**
 * Creates a dietician account: a Supabase identity + its linked Mongo
 * profile. Dieticians have no self-registration flow (by design - they're
 * provisioned by an admin), so this replaces the old bcrypt-seeding
 * approach now that Supabase owns credentials.
 *
 * Usage:
 *   node scripts/createDieticianAccount.js <email> <password> <username> <fullName>
 */
require('dotenv').config();
const mongoose = require('mongoose');

const run = async () => {
  const [, , email, password, username, ...fullNameParts] = process.argv;
  const fullName = fullNameParts.join(' ');

  if (!email || !password || !username || !fullName) {
    console.error(
      'Usage: node scripts/createDieticianAccount.js <email> <password> <username> <fullName>'
    );
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGODB_URI);
  console.log('MongoDB connected');

  const { getSupabaseAdmin } = require('../utils/supabaseAuth');
  const User = require('../models/User');

  try {
    const existing = await User.findOne({ $or: [{ email }, { username }] });
    if (existing) {
      console.error(`A user with this email or username already exists: ${existing._id}`);
      process.exit(1);
    }

    const { data, error } = await getSupabaseAdmin().auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });

    if (error) {
      console.error('Failed to create Supabase user:', error.message);
      process.exit(1);
    }

    try {
      // healthProfile.bmi/weightIndex are `required` on the shared User
      // schema even though they're meaningless for a dietician - the
      // schema has no per-role conditional requirements, so every role
      // needs placeholder values here.
      const user = await User.create({
        supabaseUserId: data.user.id,
        username,
        email,
        role: 'dietician',
        profile: { fullName },
        healthProfile: { bmi: 0, weightIndex: 0 },
        isVerified: true,
      });

      console.log('\n✅ Dietician account created:');
      console.log(`   Mongo User ID: ${user._id}`);
      console.log(`   Supabase User ID: ${data.user.id}`);
      console.log(`   Email: ${email}`);
      console.log(`   Username: ${username}`);
    } catch (mongoErr) {
      // Roll back the Supabase identity so a failed run doesn't leave an
      // orphaned account that then blocks retrying with the same email.
      await getSupabaseAdmin().auth.admin.deleteUser(data.user.id).catch(() => {});
      throw mongoErr;
    }
  } catch (err) {
    console.error('Error:', err);
    process.exit(1);
  } finally {
    await mongoose.connection.close();
  }
};

run();
