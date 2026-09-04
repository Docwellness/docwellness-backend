/**
 * Backfills DietPlan.membershipPlan (added for the renewal-parity change -
 * the dietician's patient profile reads this snapshot for the membership
 * badge / avatar ring so they stay on the *current* cycle's tier while a
 * renewal is being built, instead of flipping to the tier the patient just
 * picked).
 *
 * For every DietPlan that has no membershipPlan yet, copy it from the
 * plan's linked DietPlanRequest.membershipPlan. Run this BEFORE any patient
 * starts a renewal on a given request - startRenewal + selectMembershipPlan
 * overwrite request.membershipPlan in place, after which the request no
 * longer knows what the older cycle was sold as. Idempotent (skips plans
 * that already have the field, or whose request has no plan name).
 *
 * Connects via connectDB() (config/database.js) - required for prod's
 * self-hosted Mongo TLS. Run from Coolify's Terminal tab for prod.
 *
 * Usage:
 *   node scripts/backfill-dietplan-membership.js            # dry run
 *   node scripts/backfill-dietplan-membership.js --execute  # write
 */

require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/database');

const EXECUTE = process.argv.includes('--execute');

async function main() {
  console.log(EXECUTE ? '=== EXECUTING ===' : '=== DRY RUN (pass --execute to write) ===');
  console.log('Connecting to MongoDB...');
  await connectDB();
  console.log('Connected.\n');

  try {
    const { DietPlan, DietPlanRequest } = require('../models');

    const plans = await DietPlan.find({
      $or: [{ membershipPlan: null }, { membershipPlan: { $exists: false } }],
    })
      .select('_id request status cycleNumber')
      .lean();

    console.log(`${plans.length} plan(s) missing membershipPlan.\n`);

    const requestIds = [...new Set(plans.map((p) => String(p.request)).filter(Boolean))];
    const requests = await DietPlanRequest.find({ _id: { $in: requestIds } })
      .select('_id membershipPlan')
      .lean();
    const planNameByRequest = new Map(
      requests.map((r) => [String(r._id), r.membershipPlan || null])
    );

    let updatable = 0;
    const ops = [];
    for (const plan of plans) {
      const name = planNameByRequest.get(String(plan.request));
      if (!name) continue;
      updatable += 1;
      console.log(`  ${plan._id} (${plan.status}, cycle ${plan.cycleNumber}) -> "${name}"`);
      ops.push({
        updateOne: { filter: { _id: plan._id }, update: { $set: { membershipPlan: name } } },
      });
    }

    console.log(`\n${updatable} plan(s) can be backfilled; ${plans.length - updatable} have no resolvable plan name.`);

    if (!EXECUTE) {
      console.log('\nDry run - no writes. Re-run with --execute.');
      return;
    }
    if (ops.length > 0) {
      const res = await DietPlan.bulkWrite(ops);
      console.log(`\nDone. Modified ${res.modifiedCount} plan(s).`);
    } else {
      console.log('\nNothing to write.');
    }
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
