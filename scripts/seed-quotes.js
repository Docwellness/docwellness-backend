/**
 * Seeds the "Daily wisdom" quotes shown in the user app's Home carousel.
 * Text-first quotes (no image) across Nutrition / Wellness / Mindfulness.
 *
 * With --wipe it first deletes the dietician's existing quotes (the old
 * image-based ones), then inserts these 12 as isActive: true.
 *
 * ── Connection ──────────────────────────────────────────────────────────────
 *   remote:       set PROD_MONGODB_URI, then --dietician-id=<id> --execute
 *   in-container: --use-default-uri --dietician-id=<id> --execute
 *   (run with no --dietician-id to list candidate dietician ids)
 * DRY RUN unless --execute.
 *
 * Usage:
 *   node scripts/seed-quotes.js --dietician-id=<ObjectId>                   # dry run
 *   node scripts/seed-quotes.js --dietician-id=<ObjectId> --wipe --execute
 */

const USE_DEFAULT_URI = process.argv.includes('--use-default-uri');

require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/database');

const EXECUTE = process.argv.includes('--execute');
const WIPE = process.argv.includes('--wipe');
const dieticianArg = process.argv.find((a) => a.startsWith('--dietician-id='));
const DIETICIAN_ID = dieticianArg
  ? dieticianArg.split('=')[1]
  : process.env.SEED_DIETICIAN_ID || null;

const QUOTES = [
  { text: 'Let food be thy medicine, and medicine be thy food.', author: 'Hippocrates', category: 'Nutrition' },
  { text: 'You don’t need to eat less — you need to eat right.', author: 'DocWellness', category: 'Nutrition' },
  { text: 'Progress, not perfection. Every meal is a fresh start.', author: 'DocWellness', category: 'Nutrition' },
  { text: 'Eat for the body you’re building, not the one you’re leaving behind.', author: 'DocWellness', category: 'Nutrition' },
  { text: 'Take care of your body. It’s the only place you have to live.', author: 'Jim Rohn', category: 'Wellness' },
  { text: 'The greatest wealth is health.', author: 'Virgil', category: 'Wellness' },
  { text: 'A healthy outside starts from the inside.', author: 'Robert Urich', category: 'Wellness' },
  { text: 'Small daily habits compound into a life you’re proud of.', author: 'DocWellness', category: 'Wellness' },
  { text: 'Your body hears everything your mind says.', author: 'Naomi Judd', category: 'Mindfulness' },
  { text: 'Almost everything works again if you unplug it for a few minutes — including you.', author: 'Anne Lamott', category: 'Mindfulness' },
  { text: 'Feelings come and go like clouds. Your breath is the anchor.', author: 'after Thich Nhat Hanh', category: 'Mindfulness' },
  { text: 'It’s not about being good at it. It’s about being good to yourself.', author: 'DocWellness', category: 'Mindfulness' },
];

async function openConnection() {
  const tlsCAFile = connectDB.resolveTlsCAFile();
  const tlsOptions = tlsCAFile ? { tls: true, tlsCAFile } : {};
  const uri = USE_DEFAULT_URI
    ? process.env.MONGODB_URI
    : process.env.PROD_MONGODB_URI;
  if (!uri) {
    console.error(
      USE_DEFAULT_URI
        ? 'MONGODB_URI is not set in this environment.'
        : 'PROD_MONGODB_URI must be set (or run in-container with --use-default-uri).'
    );
    process.exit(1);
  }
  if (uri.startsWith('mongodb+srv://')) {
    require('dns').setServers(['8.8.8.8', '1.1.1.1']);
  }
  const conn = mongoose.createConnection(uri, tlsOptions);
  await conn.asPromise();
  return conn;
}

async function main() {
  console.log(
    EXECUTE ? '=== EXECUTING quote seed ===' : '=== DRY RUN (pass --execute) ==='
  );
  const conn = await openConnection();
  console.log(`Connected to DB "${conn.name}" @ ${conn.host}:${conn.port}`);
  const quotes = conn.collection('quotes');

  if (!DIETICIAN_ID || !mongoose.Types.ObjectId.isValid(DIETICIAN_ID)) {
    const byDietician = await quotes
      .aggregate([{ $group: { _id: '$dieticianId', count: { $sum: 1 } } }])
      .toArray();
    const dieticians = await conn
      .collection('users')
      .find({ role: 'dietician' })
      .project({ 'profile.fullName': 1, email: 1 })
      .toArray();
    console.log('\nNo valid --dietician-id. Candidates:');
    console.table(
      dieticians.map((d) => ({
        _id: String(d._id),
        name: d.profile && d.profile.fullName,
        email: d.email,
      }))
    );
    console.log('Existing quotes by dieticianId:');
    console.table(
      byDietician.map((g) => ({ dieticianId: String(g._id), quotes: g.count }))
    );
    await conn.close();
    process.exitCode = 1;
    return;
  }

  const dieticianId = new mongoose.Types.ObjectId(DIETICIAN_ID);

  try {
    const existing = await quotes.countDocuments({ dieticianId });
    console.log(`\nExisting quotes for this dietician: ${existing}`);
    console.log(
      WIPE
        ? `--wipe: ${EXECUTE ? 'deleting' : 'would delete'} all ${existing}`
        : '(pass --wipe to remove the existing ones first)'
    );

    console.log(`\n${EXECUTE ? 'Inserting' : 'Would insert'} ${QUOTES.length} quotes:`);
    console.table(
      QUOTES.map((q) => ({ category: q.category, author: q.author, text: q.text.slice(0, 60) }))
    );

    if (!EXECUTE) {
      console.log('\nDry run - no writes. Re-run with --execute.');
      return;
    }

    if (WIPE) {
      const del = await quotes.deleteMany({ dieticianId });
      console.log(`Deleted ${del.deletedCount} existing quote(s).`);
    }

    const now = new Date();
    const docs = QUOTES.map((q, i) => ({
      dieticianId,
      imageUrl: '',
      cloudinaryPublicId: '',
      text: q.text,
      author: q.author,
      category: q.category,
      isActive: true,
      // Spread createdAt so the carousel/notification "latest" ordering is
      // stable and matches array order (index 0 = newest).
      createdAt: new Date(now.getTime() - i * 60000),
      updatedAt: now,
      __v: 0,
    }));
    const res = await quotes.insertMany(docs, { ordered: false });
    console.log(`\nInserted ${res.insertedCount} quotes.`);
  } finally {
    await conn.close();
  }
}

main().catch((err) => {
  console.error('Quote seed failed:', err);
  process.exit(1);
});
