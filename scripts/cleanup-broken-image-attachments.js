/**
 * Cleanup script: removes/clears chat messages whose `attachment` is a
 * device-local file path (saved before the image-upload was correct).
 *
 * Identifies records whose attachment looks like a local Android/iOS path
 * (e.g. starts with `/data/`, `/storage/`, or `file://`) and:
 *   - Deletes the message if it has no text content (pure broken image)
 *   - Otherwise clears the attachment + flips messageType to 'text'
 *
 * Usage:
 *   node scripts/cleanup-broken-image-attachments.js          # dry run
 *   node scripts/cleanup-broken-image-attachments.js --apply  # apply
 *
 * Run from the DocwellNess Backend directory.
 */

const mongoose = require('mongoose');
require('dotenv').config();

const APPLY = process.argv.includes('--apply');

const LOCAL_PATTERNS = [
  /^\/data\//i,
  /^\/storage\//i,
  /^file:\/\//i,
  /^\/var\/mobile\//i,
  /^\/private\/var\//i,
];

function isLocalPath(p) {
  if (!p || typeof p !== 'string') return false;
  if (p.startsWith('http://') || p.startsWith('https://')) return false;
  return LOCAL_PATTERNS.some((rx) => rx.test(p));
}

async function run() {
  if (!process.env.MONGODB_URI) {
    console.error('MONGODB_URI missing');
    process.exit(1);
  }
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;
  const chats = db.collection('chats');

  console.log(`\n=== CLEAN BROKEN IMAGE ATTACHMENTS ${APPLY ? '(APPLY)' : '(DRY RUN)'} ===\n`);

  const candidates = await chats
    .find({ attachment: { $type: 'string' }, messageType: 'image' })
    .toArray();

  const broken = candidates.filter((m) => isLocalPath(m.attachment));
  console.log(`Image messages scanned: ${candidates.length}, broken: ${broken.length}\n`);

  const toDelete = [];
  const toUpdate = [];

  for (const m of broken) {
    const hasText = (m.message || '').trim().length > 0;
    if (hasText) {
      toUpdate.push(m._id);
      console.log(
        `  • id=${m._id} → keep as text "${m.message.slice(0, 30)}", clear attachment`
      );
    } else {
      toDelete.push(m._id);
      console.log(`  • id=${m._id} → DELETE (no text, broken attachment)`);
    }
  }

  console.log(`\nWould delete: ${toDelete.length}, would update: ${toUpdate.length}`);

  if (!APPLY) {
    console.log('\n(Dry run. Re-run with --apply to apply.)');
  } else {
    if (toDelete.length) {
      const r1 = await chats.deleteMany({ _id: { $in: toDelete } });
      console.log(`\n✅ Deleted ${r1.deletedCount} messages.`);
    }
    if (toUpdate.length) {
      const r2 = await chats.updateMany(
        { _id: { $in: toUpdate } },
        { $set: { attachment: null, messageType: 'text' } }
      );
      console.log(`✅ Updated ${r2.modifiedCount} messages (cleared attachment).`);
    }
  }

  await mongoose.disconnect();
}

run().catch((e) => {
  console.error('Failed:', e);
  process.exit(1);
});
