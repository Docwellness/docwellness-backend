/**
 * One-time migration: removes the retired `username` field from every User
 * document and drops its unique index, now that signup/login/patient-delete
 * confirmation all use email instead (see models/User.js).
 *
 * Usage:
 *   node scripts/migrateRemoveUsername.js
 */
require('dotenv').config();
const mongoose = require('mongoose');

const run = async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('MongoDB connected');

  try {
    const collection = mongoose.connection.db.collection('users');

    const unsetResult = await collection.updateMany(
      { username: { $exists: true } },
      { $unset: { username: '' } }
    );
    console.log(`Unset username on ${unsetResult.modifiedCount} user document(s)`);

    const indexes = await collection.indexes();
    const usernameIndex = indexes.find((idx) => idx.key && idx.key.username);
    if (usernameIndex) {
      await collection.dropIndex(usernameIndex.name);
      console.log(`Dropped index: ${usernameIndex.name}`);
    } else {
      console.log('No username index found (already dropped)');
    }

    console.log('\n✅ Migration complete');
  } catch (err) {
    console.error('Migration failed:', err);
    process.exit(1);
  } finally {
    await mongoose.connection.close();
  }
};

run();
