/**
 * Runs the product-placement sweep once and exits: starts scheduled placements
 * whose start date has arrived, and expires active ones whose end date has
 * passed (restoring the entry's previous main image). Idempotent.
 *
 * Meant for a Coolify "Scheduled Task" on the backend application, every 10
 * minutes (cron `*\/10 * * * *`), so no curl, secret or HTTP call is needed:
 *
 *   node scripts/run-placement-sweep.js
 *
 * Uses connectDB() so prod's private-CA TLS settings apply. Equivalent to
 * POST /api/internal/cron/placements.
 */
require('dotenv').config({ quiet: true });
const mongoose = require('mongoose');
const connectDB = require('../config/database');
const { runPlacementSweep } = require('../utils/placementEngine');

(async () => {
  try {
    await connectDB();
    const result = await runPlacementSweep();
    console.log(`[placement-sweep] ${new Date().toISOString()} ${JSON.stringify(result)}`);
    await mongoose.disconnect();
    process.exit(result.errors > 0 ? 1 : 0);
  } catch (err) {
    console.error('[placement-sweep] failed:', err.message);
    try {
      await mongoose.disconnect();
    } catch {
      // ignore
    }
    process.exit(1);
  }
})();
