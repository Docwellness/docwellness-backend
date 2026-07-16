require('../config/instrument');
const createApp = require('../config/createApp');
const connectDB = require('../config/database');

const app = createApp();

// Ensure a DB connection exists before handling the request. connectDB()
// reuses the existing connection on warm invocations instead of reconnecting
// every time, which would otherwise exhaust MongoDB's connection limit under
// concurrent serverless invocations.
module.exports = async (req, res) => {
  await connectDB();
  return app(req, res);
};
