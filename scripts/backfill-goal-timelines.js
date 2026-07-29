/**
 * Backfill Migration Script: Seed a Goal Journey Timeline for every patient
 * with an already-Active DietPlan, who signed up before the Goal Journey
 * Timeline feature existed (so activateDietPlan's new seeding hook never
 * ran for them).
 *
 * Safe to re-run: seedGoalTimeline() itself is idempotent (skips patients
 * who already have an active Goal, extends rather than duplicates one
 * whose diet plan has since been renewed to a later endDate).
 *
 * Run once after deploying the Goal Journey Timeline models:
 *   node scripts/backfill-goal-timelines.js
 */

require('dotenv').config();
const mongoose = require('mongoose');
const config = require('../config/environment');

async function run() {
  try {
    console.log('Connecting to MongoDB...');
    await mongoose.connect(config.mongoUri || process.env.MONGODB_URI);
    console.log('Connected.');

    const { DietPlan } = require('../models');
    const { seedGoalTimeline } = require('../utils/seedGoalTimeline');

    const activePlans = await DietPlan.find({ status: 'Active' }).populate('request');
    console.log(`Found ${activePlans.length} active diet plan(s) to check.`);

    let seeded = 0;
    let skipped = 0;
    let failed = 0;

    for (const plan of activePlans) {
      try {
        const goal = await seedGoalTimeline(plan);
        if (goal) {
          seeded++;
        } else {
          skipped++;
        }
      } catch (err) {
        failed++;
        console.error(`  Failed for patient ${plan.patientId}:`, err.message);
      }
    }

    console.log(`Done. Seeded/extended: ${seeded}, skipped (no target weight): ${skipped}, failed: ${failed}.`);
    process.exit(0);
  } catch (error) {
    console.error('Backfill failed:', error);
    process.exit(1);
  }
}

run();
