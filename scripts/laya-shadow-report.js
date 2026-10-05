/**
 * Read-only report over Laya shadow rows (GenerationLog, layaMode 'shadow').
 * Makes no writes. Run it where the app's MONGODB_URI works - for prod that
 * means the backend container's Coolify Terminal (it has the env and the
 * private DB address), not a laptop.
 *
 * Usage:
 *   node scripts/laya-shadow-report.js [--surface=recipe_classification]
 *        [--exclude-dietician=<id>[,<id>...]] [--since=2026-10-05T09:00:00Z]
 *
 * --exclude-dietician is how test traffic is kept out of the numbers: pass
 * the _id of any account used for manual/test generations. The report says
 * how many rows it excluded so nothing disappears silently.
 *
 * "Agreement" here is Laya vs the slot the dietician REQUESTED - a
 * consistency signal, not accuracy. Accuracy needs the reviewed dataset
 * (tests/laya/README.md, scripts/laya-eval-run.js).
 */
require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/database');
const GenerationLog = require('../models/GenerationLog');
const { summarizeShadowRows } = require('../utils/layaEval');

function parseArgs(argv) {
  const out = {};
  for (const a of argv.slice(2)) {
    const m = a.match(/^--([^=]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

(async () => {
  const args = parseArgs(process.argv);
  const surface = args.surface || 'recipe_classification';
  const excludeDieticianIds = (args['exclude-dietician'] || '').split(',').map((s) => s.trim()).filter(Boolean);
  const query = { layaMode: 'shadow', layaSurface: surface };
  if (args.since) query.createdAt = { $gte: new Date(args.since) };

  await connectDB();
  const rows = await GenerationLog.find(query).lean();
  console.log(JSON.stringify(summarizeShadowRows(rows, { excludeDieticianIds, surface }), null, 2));
  await mongoose.disconnect();
})().catch((err) => {
  console.error('laya-shadow-report failed:', err.message);
  process.exit(1);
});
