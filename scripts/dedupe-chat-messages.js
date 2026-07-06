/**
 * Cleanup script: removes duplicate Chat (legacy) messages.
 *
 * A duplicate is defined as another `chats` document with the SAME:
 *   - conversationId
 *   - senderId
 *   - messageType
 *   - message  (text content)
 *   - attachment (image url, if any)
 *   - createdAt rounded to the nearest 2 seconds
 *
 * The OLDEST record in each duplicate group is kept, the rest are deleted.
 *
 * Usage:
 *   node scripts/dedupe-chat-messages.js          # dry-run (only prints)
 *   node scripts/dedupe-chat-messages.js --apply  # actually delete
 *
 * Run from the DocwellNess Backend directory.
 */

const mongoose = require('mongoose');
require('dotenv').config();

const APPLY = process.argv.includes('--apply');

async function dedupe() {
  if (!process.env.MONGODB_URI) {
    console.error('❌ MONGODB_URI is missing in .env');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;
  const chats = db.collection('chats');

  console.log(`\n=== CHAT DEDUPE ${APPLY ? '(APPLY MODE)' : '(DRY RUN)'} ===\n`);

  const total = await chats.countDocuments({});
  console.log(`Total chat messages in DB: ${total}`);

  // Group by conversation+sender+type+message+attachment + 2-second time bucket.
  // We use $toLong on createdAt and integer-divide by 2000ms to bucket.
  const pipeline = [
    {
      $addFields: {
        _bucket: {
          $floor: {
            $divide: [{ $toLong: '$createdAt' }, 2000],
          },
        },
      },
    },
    {
      $group: {
        _id: {
          conversationId: '$conversationId',
          senderId: '$senderId',
          messageType: '$messageType',
          message: '$message',
          attachment: '$attachment',
          bucket: '$_bucket',
        },
        ids: { $push: { _id: '$_id', createdAt: '$createdAt' } },
        count: { $sum: 1 },
      },
    },
    { $match: { count: { $gt: 1 } } },
    { $sort: { count: -1 } },
  ];

  const dupGroups = await chats.aggregate(pipeline, { allowDiskUse: true }).toArray();
  console.log(`Found ${dupGroups.length} duplicate groups.\n`);

  let totalToDelete = 0;
  const idsToDelete = [];

  for (const grp of dupGroups) {
    // Keep the oldest, delete the rest.
    grp.ids.sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    );
    const keep = grp.ids[0];
    const remove = grp.ids.slice(1);
    totalToDelete += remove.length;

    const preview = (grp._id.message || '').slice(0, 40).replace(/\n/g, ' ');
    console.log(
      `  • conv=${grp._id.conversationId} sender=${grp._id.senderId} ` +
        `type=${grp._id.messageType} count=${grp.count} ` +
        `msg="${preview}" → keep ${keep._id}, delete ${remove.length}`
    );

    for (const r of remove) idsToDelete.push(r._id);
  }

  console.log(`\nTotal duplicate documents to delete: ${totalToDelete}`);

  if (!APPLY) {
    console.log('\n(Dry run. Re-run with --apply to actually delete.)');
  } else if (idsToDelete.length > 0) {
    const res = await chats.deleteMany({ _id: { $in: idsToDelete } });
    console.log(`\n✅ Deleted ${res.deletedCount} duplicate chat messages.`);
  } else {
    console.log('\nNothing to delete.');
  }

  await mongoose.disconnect();
}

dedupe().catch((err) => {
  console.error('❌ Dedupe failed:', err);
  process.exit(1);
});
