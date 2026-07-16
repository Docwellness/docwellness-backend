const mongoose = require('mongoose');

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
  return conn.connection;
};

module.exports = connectDB;
