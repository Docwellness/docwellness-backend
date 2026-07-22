const mongoose = require('mongoose');

let usernameIndexCleanupAttempted = false;

// Self-healing cleanup for a stale unique index left over from the
// `username` field's removal (models/User.js no longer defines it at all -
// see git history). Every new User document now has no `username` field,
// which Mongo's old unique index still treats as `null` - so the second
// registration onward collides on that shared null and fails with a
// duplicate-key error. Runs here (using the server's own already-correct
// connection) rather than as a manually-triggered migration script, since
// there's no reliable way to run one-off scripts against whichever
// environment (dev/prod) actually ends up deployed - this way it just
// self-heals wherever this code runs. Guarded to attempt once per warm
// process (cheap no-op via the try/catch once the index is actually gone,
// so repeat cold starts on serverless cost one harmless lookup each).
async function dropStaleUsernameIndex(connection) {
  if (usernameIndexCleanupAttempted) return;
  usernameIndexCleanupAttempted = true;
  try {
    const collection = connection.db.collection('users');
    const indexes = await collection.indexes();
    const usernameIndex = indexes.find((idx) => idx.key && idx.key.username);
    if (usernameIndex) {
      await collection.dropIndex(usernameIndex.name);
      console.log(`dropStaleUsernameIndex: dropped stale index ${usernameIndex.name}`);
    }
  } catch (error) {
    // Never fatal - a failed cleanup attempt shouldn't block server startup.
    console.error('dropStaleUsernameIndex: cleanup failed (non-fatal):', error.message);
  }
}

/**
 * Database connection configuration.
 *
 * Reuses an existing connection when one is already open/connecting so this
 * is safe to call on every invocation of a serverless function (Vercel),
 * not just once at process startup like on the VPS.
 */
const connectDB = async () => {
  if (mongoose.connection.readyState === 1 || mongoose.connection.readyState === 2) {
    return mongoose.connection;
  }

  const conn = await mongoose.connect(process.env.MONGODB_URI);
  console.log(`MongoDB Connected: ${conn.connection.host}`);
  await dropStaleUsernameIndex(conn.connection);
  return conn.connection;
};

module.exports = connectDB;
