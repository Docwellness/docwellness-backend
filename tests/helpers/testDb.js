/**
 * Test DB lifecycle - AI_EXECUTION_PLAN.md Phase 8, P8-01.
 *
 * Real MongoDB semantics (not mocked queries) via mongodb-memory-server -
 * downloads/runs an actual mongod binary in-process, so these tests
 * exercise real Mongoose validation, indexes, and query behavior instead
 * of a hand-rolled fake that could silently diverge from production
 * behavior. Env vars are set here, before any test file requires
 * config/environment.js (which fails fast on missing required vars
 * outside NODE_ENV=test) or config/database.js (which reads
 * MONGODB_URI at connect() call time, not module load time).
 */

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';
// config/environment.js captures process.env.DEFAULT_DIETICIAN_ID into a
// plain property ONCE, at module-load time - it can't be changed per-test
// afterwards. Fixed to a syntactically-valid (but obviously fake) ObjectId
// here, and tests/helpers/factories.js's createDefaultDietician() creates
// a dietician document with this exact _id, so any code path that reads
// config.defaultDieticianId (patient-side chat auto-routing, meal-log
// chat-sync notifications, etc.) resolves to a real seeded user instead of
// throwing a Mongoose CastError on an empty string.
const DEFAULT_DIETICIAN_ID = '000000000000000000000001';
process.env.DEFAULT_DIETICIAN_ID = DEFAULT_DIETICIAN_ID;

const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

let mongod;

async function connectTestDb() {
  mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri();
  await mongoose.connect(process.env.MONGODB_URI);
}

async function disconnectTestDb() {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  if (mongod) {
    await mongod.stop();
    mongod = undefined;
  }
}

async function clearTestDb() {
  const { collections } = mongoose.connection;
  await Promise.all(
    Object.values(collections).map((collection) => collection.deleteMany({}))
  );
}

module.exports = { connectTestDb, disconnectTestDb, clearTestDb, DEFAULT_DIETICIAN_ID };
