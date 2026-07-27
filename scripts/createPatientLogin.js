/**
 * Creates a Supabase auth identity for an existing Mongo User (patient)
 * that doesn't have one yet, and links it via supabaseUserId - the reverse
 * of the normal signup order (Supabase account first, then Mongo profile
 * completion via the app's registration flow). Needed for a patient
 * profile that was created directly in Mongo (e.g. scripts/create-test-
 * renewal-patient.js) rather than through real self-registration, and so
 * has no way to log in yet.
 *
 * Mirrors createDieticianAccount.js's Supabase admin.createUser call, but
 * links onto an *existing* Mongo profile instead of creating a new one.
 *
 * Usage:
 *   node scripts/createPatientLogin.js <email> <password>
 */
require('dotenv').config();
// See scripts/test-components-generation.js for why this is needed - Node's
// own DNS resolver can fail on the SRV-record lookup a "mongodb+srv://" URI
// needs even when other tools on the same machine resolve it fine.
require('dns').setServers(['8.8.8.8', '1.1.1.1']);
const mongoose = require('mongoose');

const run = async () => {
  const [, , email, password] = process.argv;
  if (!email || !password) {
    console.error('Usage: node scripts/createPatientLogin.js <email> <password>');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGODB_URI);
  console.log('MongoDB connected');

  const { getSupabaseAdmin } = require('../utils/supabaseAuth');
  const { User } = require('../models');

  try {
    const user = await User.findOne({ email });
    if (!user) {
      console.error(`No Mongo User found for ${email}`);
      process.exit(1);
    }
    if (user.supabaseUserId) {
      console.error(`This user already has a linked Supabase account: ${user.supabaseUserId}`);
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

    user.supabaseUserId = data.user.id;
    await user.save();

    console.log('\n✅ Login created and linked:');
    console.log(`   Mongo User ID: ${user._id}`);
    console.log(`   Supabase User ID: ${data.user.id}`);
    console.log(`   Email: ${email}`);
    console.log(`   Password: ${password}`);
  } catch (err) {
    console.error('Error:', err);
    process.exit(1);
  } finally {
    await mongoose.connection.close();
  }
};

run();
