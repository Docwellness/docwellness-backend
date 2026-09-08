/**
 * Seeds the 13 Docwellness YouTube Shorts into prod as visible patient
 * videos (the "Videos for you" carousel on the user app's Home).
 *
 * Each row becomes a Video document:
 *   - source: 'YouTube'
 *   - youtubeUrl: the /shorts/<id> URL
 *   - thumbnailUrl: https://i.ytimg.com/vi/<id>/oardefault.jpg
 *       ^ YouTube's original-aspect-ratio (9:16) Shorts frame - no 4:3
 *         letterboxing like hqdefault.jpg. The app already prefers an
 *         explicit thumbnailUrl over its hqdefault fallback
 *         (see videos_section.dart _getThumbnail).
 *   - visibleToUser: true
 *   - dieticianId: the prod dietician these should belong to
 *
 * Idempotent: a video is skipped if this dietician already has one with the
 * same youtubeUrl (matched by video id, so a /watch?v= vs /shorts/ variant
 * still counts as the same video).
 *
 * Follows the same prod-connection contract as
 * migrate-dev-catalog-to-prod.js: PROD_MONGODB_URI must be set explicitly
 * (never guessed/defaulted), and the prod TLS CA comes from connectDB's own
 * resolveTlsCAFile.
 *
 * Usage:
 *   node scripts/seed-prod-videos.js --dietician-id=<ObjectId>            # dry run
 *   node scripts/seed-prod-videos.js --dietician-id=<ObjectId> --execute  # write
 *
 * If --dietician-id is omitted, PROD_DEFAULT_DIETICIAN_ID is used when set.
 */

// Same DNS fix as the other prod scripts - the default system resolver on
// this machine doesn't handle mongodb+srv:// SRV/TXT lookups.
require('dns').setServers(['8.8.8.8', '1.1.1.1']);

require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/database');

const EXECUTE = process.argv.includes('--execute');
const dieticianArg = process.argv.find((a) => a.startsWith('--dietician-id='));
const DIETICIAN_ID = dieticianArg
  ? dieticianArg.split('=')[1]
  : process.env.PROD_DEFAULT_DIETICIAN_ID || null;

// Order here is display order intent (newest-first is how the app sorts, so
// the first entry is inserted last / ends up on top). Titles are lightly
// curated - the raw YouTube titles are mostly repeated "Like, Share,
// Subscribe" CTAs; the dietician can rename any of these from their app.
const VIDEOS = [
  { id: 'WxcuatHGznw', title: '' },
  { id: 'hWKgtxkg7i4', title: '' },
  { id: '3iqcoFRm5HY', title: '' },
  { id: 'c3ENdll35tE', title: '' },
  { id: 'Q8h-gHbMLPA', title: 'Building core strength? Try this one' },
  { id: 'e5TjSga3KH8', title: 'The smarter way to burn fat starts here' },
  { id: '5UOfPmkGcB8', title: 'Where to start toning your upper body' },
  { id: 'lqxBlbWItZ8', title: 'In my own world, and I love it' },
  { id: '6Pbk1wYDWn8', title: 'Toned arms workout - save for later' },
  { id: 'CYaoTh2qDGo', title: 'Full body with just two dumbbells' },
  { id: 'Gc6Yb4BfY9Q', title: 'Lower body exercises' },
  { id: 'bz8bBm7UTPI', title: 'Save this workout for later' },
  { id: 'elv3kA2Jbgo', title: 'My musical warm-up' },
];

const ytIdFromUrl = (url = '') => {
  const m = String(url).match(
    /(?:shorts\/|watch\?v=|youtu\.be\/|embed\/)([a-zA-Z0-9_-]{11})/
  );
  return m ? m[1] : null;
};

async function main() {
  if (!process.env.PROD_MONGODB_URI) {
    console.error(
      'PROD_MONGODB_URI must be set (the prod database to seed INTO) - refusing to guess or default this.'
    );
    process.exit(1);
  }

  console.log(
    EXECUTE
      ? '=== EXECUTING prod video seed ==='
      : '=== DRY RUN (pass --execute to write) ==='
  );

  console.log('Connecting to prod MongoDB...');
  const tlsCAFile = connectDB.resolveTlsCAFile();
  const prodOptions = tlsCAFile ? { tls: true, tlsCAFile } : {};
  const prodConn = mongoose.createConnection(
    process.env.PROD_MONGODB_URI,
    prodOptions
  );
  await prodConn.asPromise();
  console.log('Connected to prod.');

  const videos = prodConn.collection('videos');

  // No dietician id given (or a bad one): show which ids prod's own data
  // already points at, so the caller can pick the right one - then stop.
  if (!DIETICIAN_ID || !mongoose.Types.ObjectId.isValid(DIETICIAN_ID)) {
    const byDietician = await videos
      .aggregate([
        { $group: { _id: '$dieticianId', count: { $sum: 1 }, visible: { $sum: { $cond: ['$visibleToUser', 1, 0] } } } },
      ])
      .toArray();
    const dieticians = await prodConn
      .collection('users')
      .find({ role: 'dietician' })
      .project({ 'profile.fullName': 1, email: 1 })
      .toArray();
    console.log('\nNo valid --dietician-id given. Candidates from prod:');
    console.log('\nDieticians (users.role = "dietician"):');
    console.table(
      dieticians.map((d) => ({
        _id: String(d._id),
        name: d.profile && d.profile.fullName,
        email: d.email,
      }))
    );
    console.log('Existing videos grouped by dieticianId:');
    console.table(
      byDietician.map((g) => ({ dieticianId: String(g._id), videos: g.count, visible: g.visible }))
    );
    console.log(
      '\nRe-run with:  node scripts/seed-prod-videos.js --dietician-id=<one of the above> [--execute]'
    );
    await prodConn.close();
    process.exit(1);
  }

  const dieticianId = new mongoose.Types.ObjectId(DIETICIAN_ID);

  try {
    // What this dietician already has, keyed by youtube video id.
    const existing = await videos
      .find({ dieticianId, source: 'YouTube' })
      .project({ youtubeUrl: 1 })
      .toArray();
    const existingIds = new Set(
      existing.map((d) => ytIdFromUrl(d.youtubeUrl)).filter(Boolean)
    );

    const now = new Date();
    const toInsert = [];
    const summary = [];

    // Iterate in reverse so array[0] gets the newest createdAt and lands on
    // top of the newest-first list the patient endpoint returns.
    for (let i = VIDEOS.length - 1; i >= 0; i--) {
      const v = VIDEOS[i];
      const youtubeUrl = `https://www.youtube.com/shorts/${v.id}`;
      const already = existingIds.has(v.id);
      summary.push({
        id: v.id,
        title: v.title || '(none)',
        status: already ? 'exists - skip' : EXECUTE ? 'insert' : 'would insert',
      });
      if (already) continue;
      toInsert.push({
        dieticianId,
        title: v.title || '',
        source: 'YouTube',
        youtubeUrl,
        thumbnailUrl: `https://i.ytimg.com/vi/${v.id}/oardefault.jpg`,
        bannerImage: '',
        videoFile: '',
        visibleToUser: true,
        text: '',
        createdAt: new Date(now.getTime() + (VIDEOS.length - i) * 1000),
        updatedAt: now,
        __v: 0,
      });
    }

    console.log('\n=== PLAN ===');
    console.table(summary.reverse());

    let inserted = 0;
    if (EXECUTE && toInsert.length > 0) {
      const res = await videos.insertMany(toInsert, { ordered: false });
      inserted = res.insertedCount;
    }

    console.log(
      `\n${EXECUTE ? 'Inserted' : 'Would insert'}: ${
        EXECUTE ? inserted : toInsert.length
      }  |  Already present: ${VIDEOS.length - toInsert.length}`
    );
    if (!EXECUTE) {
      console.log('Dry run - no writes. Re-run with --execute to seed prod.');
    }
  } finally {
    await prodConn.close();
  }
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
