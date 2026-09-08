/**
 * Seeds the 13 Docwellness YouTube Shorts as visible patient videos (the
 * "Videos for you" carousel on the user app's Home).
 *
 * Each row becomes a Video document:
 *   - source: 'YouTube'
 *   - youtubeUrl: the /shorts/<id> URL
 *   - thumbnailUrl: https://i.ytimg.com/vi/<id>/oardefault.jpg
 *       ^ YouTube's original-aspect-ratio (9:16) Shorts frame - no 4:3
 *         letterboxing like hqdefault.jpg. The app prefers an explicit
 *         thumbnailUrl over its own fallback (see videoThumb() in
 *         docwellness-user/lib/app/modules/home/widgets/videos_section.dart).
 *   - visibleToUser: true
 *   - dieticianId: the dietician these should belong to
 *
 * Idempotent: a video is skipped if that dietician already has one with the
 * same YouTube id (a /watch?v= vs /shorts/ variant still counts as the same).
 *
 * ── Connection ──────────────────────────────────────────────────────────────
 * Two modes:
 *
 *   A. From your machine, against remote prod:
 *        set PROD_MONGODB_URI in the shell, then:
 *        node scripts/seed-prod-videos.js --dietician-id=<id> [--execute]
 *
 *   B. Inside the deployed backend container (Coolify "Execute Command" /
 *      `docker exec`), where MONGODB_URI already points at that env's own DB:
 *        node scripts/seed-prod-videos.js --use-default-uri --dietician-id=<id> [--execute]
 *
 * Either way it is a DRY RUN unless --execute is passed, and it prints the DB
 * host it connected to first so you can sanity-check before writing.
 *
 * Run with no --dietician-id to print candidate dietician ids from the DB.
 */

const USE_DEFAULT_URI = process.argv.includes('--use-default-uri');

// mongodb+srv:// needs an SRV lookup the default resolver on a dev machine
// sometimes drops - force public DNS for the local-run case only. NOT inside
// a container, where Mongo may be a private/docker-network hostname that
// public DNS can't resolve.
if (!USE_DEFAULT_URI) {
  require('dns').setServers(['8.8.8.8', '1.1.1.1']);
}

require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/database');

const EXECUTE = process.argv.includes('--execute');
const dieticianArg = process.argv.find((a) => a.startsWith('--dietician-id='));
const DIETICIAN_ID = dieticianArg
  ? dieticianArg.split('=')[1]
  : process.env.SEED_DIETICIAN_ID || null;

// Order here is display-order intent: the patient endpoint sorts newest-first,
// so array[0] is inserted with the newest createdAt and lands on top. Titles
// are lightly curated (the raw YouTube titles are mostly repeated "Like,
// Share, Subscribe" CTAs); the dietician can rename any from their app.
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
        : 'PROD_MONGODB_URI must be set (or run inside the deployed container with --use-default-uri).'
    );
    process.exit(1);
  }

  const conn = mongoose.createConnection(uri, tlsOptions);
  await conn.asPromise();
  return conn;
}

async function main() {
  console.log(
    EXECUTE
      ? '=== EXECUTING video seed ==='
      : '=== DRY RUN (pass --execute to write) ==='
  );

  const conn = await openConnection();
  console.log(
    `Connected to DB "${conn.name}" @ ${conn.host}:${conn.port}` +
      (USE_DEFAULT_URI ? '  (via MONGODB_URI)' : '  (via PROD_MONGODB_URI)')
  );

  const videos = conn.collection('videos');

  try {
    // No dietician id given (or a bad one): show which ids the DB's own data
    // already points at, so the caller can pick the right one - then stop.
    if (!DIETICIAN_ID || !mongoose.Types.ObjectId.isValid(DIETICIAN_ID)) {
      const byDietician = await videos
        .aggregate([
          {
            $group: {
              _id: '$dieticianId',
              count: { $sum: 1 },
              visible: { $sum: { $cond: ['$visibleToUser', 1, 0] } },
            },
          },
        ])
        .toArray();
      const dieticians = await conn
        .collection('users')
        .find({ role: 'dietician' })
        .project({ 'profile.fullName': 1, email: 1 })
        .toArray();
      console.log('\nNo valid --dietician-id given. Candidates from this DB:');
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
        byDietician.map((g) => ({
          dieticianId: String(g._id),
          videos: g.count,
          visible: g.visible,
        }))
      );
      console.log(
        '\nRe-run with:  --dietician-id=<one of the above> [--execute]'
      );
      process.exitCode = 1;
      return;
    }

    const dieticianId = new mongoose.Types.ObjectId(DIETICIAN_ID);

    // What this dietician already has, keyed by YouTube video id.
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

    for (let i = VIDEOS.length - 1; i >= 0; i--) {
      const v = VIDEOS[i];
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
        youtubeUrl: `https://www.youtube.com/shorts/${v.id}`,
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
      console.log('Dry run - no writes. Re-run with --execute to seed.');
    }
  } finally {
    await conn.close();
  }
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
