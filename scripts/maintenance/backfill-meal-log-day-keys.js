#!/usr/bin/env node
// One-time backfill for MealLog.dayKey (see models/MealLog.js) on documents
// written before that field existed. Must run before
// scripts/maintenance/ensure-indexes.js can successfully build the new
// unique { patientId, dayKey } index: a compound sparse index only skips a
// document that's missing EVERY indexed field, and patientId is always
// present, so every dayKey-less document would otherwise be indexed as
// dayKey: null and collide with any other dayKey-less document for the same
// patient.
//
// Safe to run repeatedly (only touches documents where dayKey is unset) and
// never modifies `date` or any other field.
//
// Usage:
//   node scripts/maintenance/backfill-meal-log-day-keys.js

require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../../config/database');
const MealLog = require('../../models/MealLog');

const normalizeDate = (dateObj) =>
  new Date(Date.UTC(dateObj.getUTCFullYear(), dateObj.getUTCMonth(), dateObj.getUTCDate()));

const dateToDayKey = (dateObj) => {
  const year = dateObj.getUTCFullYear();
  const month = String(dateObj.getUTCMonth() + 1).padStart(2, '0');
  const day = String(dateObj.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

async function main() {
  console.log('Connecting to MongoDB...');
  await connectDB();
  console.log('Connected.\n');

  const missing = await MealLog.find({ dayKey: { $in: [null, undefined] } })
    .select('_id patientId date')
    .lean();

  console.log(`Found ${missing.length} MealLog document(s) missing dayKey.`);

  // Surface genuine same-patient-same-day duplicates up front - a backfill
  // can't resolve those on its own (which document should "win" the
  // eventual unique index needs a human call), so report and stop rather
  // than silently backfilling into a state the next ensure-indexes run will
  // just fail on anyway.
  const seen = new Map();
  const dupes = [];
  for (const doc of missing) {
    const key = `${doc.patientId}|${dateToDayKey(normalizeDate(new Date(doc.date)))}`;
    if (seen.has(key)) {
      dupes.push([seen.get(key), doc._id.toString()]);
    } else {
      seen.set(key, doc._id.toString());
    }
  }
  if (dupes.length > 0) {
    console.error(`\n${dupes.length} same-patient-same-day duplicate pair(s) found - resolve these manually before re-running:`);
    dupes.forEach(([a, b]) => console.error(`  ${a} <-> ${b}`));
    await mongoose.disconnect();
    process.exit(1);
  }

  let updated = 0;
  for (const doc of missing) {
    const dayKey = dateToDayKey(normalizeDate(new Date(doc.date)));
    await MealLog.updateOne({ _id: doc._id }, { $set: { dayKey } });
    updated += 1;
  }

  console.log(`\nBackfilled dayKey on ${updated} document(s).`);
  await mongoose.disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error('backfill-meal-log-day-keys failed unexpectedly:', err);
  process.exit(1);
});
