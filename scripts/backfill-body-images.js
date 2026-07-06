/**
 * Backfill Migration Script: Copy beforeImage → bodyImage on Progress records
 *
 * This script scans all existing Progress documents that have a beforeImage set
 * but no bodyImage, and copies the URL to the new bodyImage field.
 *
 * Run once after deploying the Progress model update:
 *   node scripts/backfill-body-images.js
 */

require('dotenv').config();
const mongoose = require('mongoose');
const config = require('../config/environment');

async function run() {
  try {
    console.log('Connecting to MongoDB...');
    await mongoose.connect(config.mongoUri || process.env.MONGODB_URI);
    console.log('Connected.');

    const Progress = require('../models/Progress');

    // Find all progress records that have beforeImage but no bodyImage
    const records = await Progress.find({
      beforeImage: { $exists: true, $ne: '' },
      $or: [{ bodyImage: { $exists: false } }, { bodyImage: '' }, { bodyImage: null }],
    });

    console.log(`Found ${records.length} records to backfill.`);

    let updated = 0;
    for (const record of records) {
      record.bodyImage = record.beforeImage;
      await record.save();
      updated++;
      if (updated % 50 === 0) {
        console.log(`  Updated ${updated}/${records.length}...`);
      }
    }

    console.log(`\nDone! Updated ${updated} records.`);
    console.log('bodyImage field now populated from existing beforeImage data.');
  } catch (error) {
    console.error('Migration failed:', error);
  } finally {
    await mongoose.disconnect();
    console.log('Disconnected from MongoDB.');
  }
}

run();
