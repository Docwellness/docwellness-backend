/**
 * Backfills the typed `days[]` schema (models/DietPlan.js, Phase 1c) on
 * every existing DietPlan from its legacy finalizedPlan/draftPlan blobs.
 *
 * Going forward, finalizeWeekPlan already dual-writes into `days[]` (see its
 * applyLegacyWeekPayload call) - this script only needs to backfill plans/
 * weeks finalized *before* that dual-write went live. It also archives any
 * draft-only week (present in draftPlan but with no corresponding
 * finalizedPlan entry for that week number) into `legacyDraftPlanArchive`,
 * since days[] must only ever hold real finalized selections.
 *
 * Idempotent - only touches plans with no `daysSchemaMigratedAt` yet, so
 * re-running after a partial failure/interruption is safe: an already-
 * migrated plan is skipped outright, and a plan mid-migration that crashed
 * before being marked migrated is simply retried in full (days[] entries
 * for a week are always fully replaced, never appended-to, so a retry can't
 * duplicate data).
 *
 * Usage:
 *   node scripts/migrate-diet-plan-typed-schema.js             # dry run (report only)
 *   node scripts/migrate-diet-plan-typed-schema.js --execute   # actually write
 *   node scripts/migrate-diet-plan-typed-schema.js --verify    # re-derive the legacy
 *                                                               # view from days[] on
 *                                                               # already-migrated plans
 *                                                               # and diff it against the
 *                                                               # original blob - run
 *                                                               # this after --execute
 *   node scripts/migrate-diet-plan-typed-schema.js --execute --verify   # both, in order
 */

require('dotenv').config();
const mongoose = require('mongoose');

const EXECUTE = process.argv.includes('--execute');
const VERIFY = process.argv.includes('--verify');

// Canonicalizes one dailyMeals entry for order-independent set comparison -
// daysFromLegacyWeekPayload groups entries by {dayGroup, servingTime}, which
// does not preserve the original array order the dietician's payload
// happened to arrive in, so --verify must compare as a multiset, not a
// strict array-order deep-equal (which would false-positive on every plan).
function canonicalizeDailyMeal(meal) {
  return JSON.stringify(
    Object.keys(meal)
      .sort()
      .reduce((acc, key) => {
        acc[key] = meal[key];
        return acc;
      }, {})
  );
}

function diffWeeks(originalWeeks, derivedWeeks) {
  const diffs = [];
  const weekNumbers = [...new Set([...originalWeeks, ...derivedWeeks].map((w) => w.week))].sort(
    (a, b) => a - b
  );

  for (const week of weekNumbers) {
    const original = (originalWeeks.find((w) => w.week === week)?.dailyMeals || [])
      .map(canonicalizeDailyMeal)
      .sort();
    const derived = (derivedWeeks.find((w) => w.week === week)?.dailyMeals || [])
      .map(canonicalizeDailyMeal)
      .sort();

    if (original.length !== derived.length || original.some((entry, i) => entry !== derived[i])) {
      diffs.push({
        week,
        originalCount: original.length,
        derivedCount: derived.length,
        missing: original.filter((e) => !derived.includes(e)),
        extra: derived.filter((e) => !original.includes(e)),
      });
    }
  }
  return diffs;
}

async function runBackfill({ DietPlan, Recipe, daysFromLegacyWeekPayload, getFinalizedWeeks, getDraftWeeks, execute = EXECUTE }) {
  const plans = await DietPlan.find({ daysSchemaMigratedAt: null });
  console.log(`Found ${plans.length} not-yet-migrated diet plan(s).`);

  let migratedCount = 0;
  let dayEntriesBackfilled = 0;
  let draftOnlyWeeksArchived = 0;
  const danglingRecipeWarnings = [];

  for (const plan of plans) {
    const finalizedWeeks = getFinalizedWeeks(plan);
    const draftWeeks = getDraftWeeks(plan);
    const finalizedWeekNumbers = new Set(finalizedWeeks.map((w) => w.week));
    const alreadyInDays = new Set((plan.days || []).map((d) => d.week));

    const recipeIds = new Set();
    for (const week of finalizedWeeks) {
      if (alreadyInDays.has(week.week)) continue; // already dual-written since finalizeWeekPlan's cutover
      const entries = daysFromLegacyWeekPayload(week);
      dayEntriesBackfilled += entries.length;
      // Filter out this week's entries ONCE, before pushing all of this
      // week's (possibly multiple, one per dayGroup) new entries - filtering
      // inside the loop below would remove entries this same loop just
      // pushed for an earlier dayGroup in the same week.
      if (execute) {
        plan.days = (plan.days || []).filter((d) => d.week !== week.week);
        plan.days.push(...entries);
      }
      for (const entry of entries) {
        for (const meal of entry.meals) {
          for (const item of meal.items) recipeIds.add(item.recipeId);
        }
      }
    }

    const draftOnlyWeeks = draftWeeks.filter((w) => !finalizedWeekNumbers.has(w.week));
    if (draftOnlyWeeks.length > 0) {
      draftOnlyWeeksArchived += draftOnlyWeeks.length;
      if (execute) {
        const existingArchive = Array.isArray(plan.legacyDraftPlanArchive?.weeks)
          ? plan.legacyDraftPlanArchive.weeks
          : [];
        const archivedWeekNumbers = new Set(existingArchive.map((w) => w.week));
        plan.legacyDraftPlanArchive = {
          weeks: [...existingArchive, ...draftOnlyWeeks.filter((w) => !archivedWeekNumbers.has(w.week))],
        };
      }
    }

    if (recipeIds.size > 0) {
      const existing = await Recipe.find({ _id: { $in: [...recipeIds] } }).select('_id').lean();
      const existingIds = new Set(existing.map((r) => r._id.toString()));
      const dangling = [...recipeIds].filter((id) => !existingIds.has(id));
      if (dangling.length > 0) {
        danglingRecipeWarnings.push({ planId: plan._id.toString(), dangling });
      }
    }

    if (execute) {
      plan.daysSchemaMigratedAt = new Date();
      plan.markModified('days');
      await plan.save();
    }
    migratedCount++;
  }

  console.log(
    `\n=== ${execute ? 'EXECUTED' : 'PLAN'}: ${migratedCount} plan(s), ${dayEntriesBackfilled} day-group entries backfilled into days[], ${draftOnlyWeeksArchived} draft-only week(s) archived ===`
  );
  if (danglingRecipeWarnings.length > 0) {
    console.log(`\n⚠ ${danglingRecipeWarnings.length} plan(s) reference a deleted Recipe (needs manual review):`);
    for (const w of danglingRecipeWarnings) console.log(`  plan ${w.planId}: ${w.dangling.join(', ')}`);
  }
  if (!execute) {
    console.log('\nThis was a dry run - no DB writes. Re-run with --execute to write these.');
  }
  return { migratedCount, dayEntriesBackfilled, draftOnlyWeeksArchived, danglingRecipeWarnings };
}

async function runVerify({ DietPlan, buildLegacyWeeksView, getFinalizedWeeks }) {
  const plans = await DietPlan.find({ daysSchemaMigratedAt: { $ne: null } });
  console.log(`\nVerifying ${plans.length} migrated diet plan(s)...`);

  let clean = 0;
  const failures = [];

  for (const plan of plans) {
    const original = getFinalizedWeeks(plan);
    const derived = buildLegacyWeeksView(plan).weeks;
    const diffs = diffWeeks(original, derived);
    if (diffs.length === 0) {
      clean++;
    } else {
      failures.push({ planId: plan._id.toString(), diffs });
    }
  }

  console.log(`\n=== VERIFY: ${clean}/${plans.length} plan(s) match exactly ===`);
  if (failures.length > 0) {
    console.log(`\n✗ ${failures.length} plan(s) diverged:`);
    for (const f of failures) {
      console.log(`  plan ${f.planId}:`);
      for (const d of f.diffs) {
        console.log(
          `    week ${d.week}: original=${d.originalCount} derived=${d.derivedCount} missing=${d.missing.length} extra=${d.extra.length}`
        );
      }
    }
    process.exitCode = 1;
  }
  return { clean, total: plans.length, failures };
}

async function main() {
  if (!EXECUTE && !VERIFY) {
    console.log('=== DRY RUN (pass --execute to write, --verify to check already-migrated plans) ===');
  }

  console.log('Connecting to MongoDB...');
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected.');

  try {
    const { DietPlan, Recipe } = require('../models');
    const { daysFromLegacyWeekPayload, buildLegacyWeeksView, getFinalizedWeeks, getDraftWeeks } = require('../utils/dietPlanLegacyView');

    await runBackfill({ DietPlan, Recipe, daysFromLegacyWeekPayload, getFinalizedWeeks, getDraftWeeks });

    if (VERIFY) {
      await runVerify({ DietPlan, buildLegacyWeeksView, getFinalizedWeeks });
    }
  } finally {
    await mongoose.disconnect();
  }
}

module.exports = { runBackfill, runVerify, diffWeeks, canonicalizeDailyMeal };

// Only run as a CLI script - requiring this file from a test (see
// tests/migrateDietPlanTypedSchema.test.js) must not auto-connect/disconnect
// or call process.exit, since the test manages its own DB lifecycle.
if (require.main === module) {
  main().catch((err) => {
    console.error('FATAL:', err);
    process.exit(1);
  });
}
