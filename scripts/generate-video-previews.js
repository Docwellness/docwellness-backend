/**
 * Generates the short muted MP4 preview clips the user app's "Videos for you"
 * rail autoplays inline (via native video_player, not the YouTube webview).
 *
 * For each YouTube Video doc missing a previewClipUrl:
 *   1. yt-dlp grabs a <=720p video-only stream (no ffmpeg / no audio merge).
 *   2. Cloudinary trims it to the first ~6s, scales to 480x854, drops audio,
 *      re-encodes H.264 + faststart, returns a CDN mp4 URL.
 *   3. That URL is written back to Video.previewClipUrl.
 *
 * yt-dlp: `python -m yt_dlp` (pip install yt-dlp) - no PATH entry needed.
 * Cloudinary creds come from the env (config/cloudinary.js).
 *
 * ── Connection ──────────────────────────────────────────────────────────────
 *   A. remote:     set PROD_MONGODB_URI, then --execute
 *   B. in-container (Coolify): --use-default-uri   (uses that env's MONGODB_URI)
 * DRY RUN unless --execute. Prints the DB host first.
 *
 * Usage:
 *   node scripts/generate-video-previews.js [--use-default-uri]
 *   node scripts/generate-video-previews.js [--use-default-uri] --execute
 *   node scripts/generate-video-previews.js --execute --force        # redo all
 *   node scripts/generate-video-previews.js --execute --id=WxcuatHGznw
 */

const USE_DEFAULT_URI = process.argv.includes('--use-default-uri');

require('dotenv').config();
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const mongoose = require('mongoose');
const connectDB = require('../config/database');
const cloudinary = require('../config/cloudinary');

const EXECUTE = process.argv.includes('--execute');
const FORCE = process.argv.includes('--force');
const idArg = process.argv.find((a) => a.startsWith('--id='));
const ONLY_ID = idArg ? idArg.split('=')[1] : null;

// yt-dlp invoked as a module so no PATH entry / .exe shim is needed.
const PYTHON = process.env.PYTHON_BIN || 'python';
const CLIP_SECONDS = 6;
const CLOUDINARY_FOLDER = 'docwellness/video-previews';

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
        : 'PROD_MONGODB_URI must be set (or run in-container with --use-default-uri).'
    );
    process.exit(1);
  }
  // mongodb+srv:// needs an SRV lookup the default resolver on a dev machine
  // sometimes drops - force public DNS. Not for plain mongodb:// (prod's
  // self-hosted host may be private / docker-network only).
  if (uri.startsWith('mongodb+srv://')) {
    require('dns').setServers(['8.8.8.8', '1.1.1.1']);
  }
  const conn = mongoose.createConnection(uri, tlsOptions);
  await conn.asPromise();
  return conn;
}

function downloadStream(youtubeUrl, outFile) {
  // Video-only, <=720p, prefer mp4/h264 - no audio means yt-dlp never needs
  // ffmpeg to mux. Cloudinary does the trim + transcode afterwards.
  const fmt =
    'bv[height<=720][ext=mp4]/bv[height<=720]/b[height<=720][ext=mp4]/b[height<=720]/b';
  execFileSync(
    PYTHON,
    [
      '-m',
      'yt_dlp',
      '--no-playlist',
      '--no-warnings',
      '--quiet',
      '-f',
      fmt,
      '-o',
      outFile,
      youtubeUrl,
    ],
    { stdio: ['ignore', 'ignore', 'inherit'], timeout: 120000 }
  );
}

async function uploadPreview(localFile, ytId) {
  const res = await cloudinary.uploader.upload(localFile, {
    resource_type: 'video',
    folder: CLOUDINARY_FOLDER,
    public_id: ytId,
    overwrite: true,
    invalidate: true,
    eager_async: false,
    eager: [
      {
        // Source is already 9:16, so c_scale to 480w keeps the frame whole
        // (~480x854). so_0/eo_6 = first 6s. ac_none drops audio.
        // (gravity:auto / crop:fill silently voids the eager on video.)
        start_offset: '0',
        end_offset: String(CLIP_SECONDS),
        width: 480,
        crop: 'scale',
        video_codec: 'h264',
        audio_codec: 'none',
        quality: 'auto:eco',
      },
    ],
  });
  const eager = res.eager && res.eager[0];
  if (!eager || !eager.secure_url) {
    throw new Error('Cloudinary upload returned no eager derivative');
  }
  return eager.secure_url;
}

async function main() {
  if (
    !process.env.CLOUDINARY_CLOUD_NAME ||
    !process.env.CLOUDINARY_API_KEY ||
    !process.env.CLOUDINARY_API_SECRET
  ) {
    console.error('CLOUDINARY_* env vars are required.');
    process.exit(1);
  }

  console.log(
    EXECUTE ? '=== EXECUTING preview generation ===' : '=== DRY RUN (pass --execute) ==='
  );

  const conn = await openConnection();
  console.log(
    `Connected to DB "${conn.name}" @ ${conn.host}:${conn.port}` +
      (USE_DEFAULT_URI ? '  (via MONGODB_URI)' : '  (via PROD_MONGODB_URI)')
  );
  const videos = conn.collection('videos');

  const filter = { source: 'YouTube', youtubeUrl: { $regex: /^https?:\/\// } };
  if (!FORCE) filter.$or = [{ previewClipUrl: { $exists: false } }, { previewClipUrl: '' }];
  const docs = await videos.find(filter).toArray();

  const targets = docs
    .map((d) => ({ _id: d._id, ytId: ytIdFromUrl(d.youtubeUrl), url: d.youtubeUrl, has: !!d.previewClipUrl }))
    .filter((t) => t.ytId && (!ONLY_ID || t.ytId === ONLY_ID));

  console.log(`\n${targets.length} video(s) to process${FORCE ? ' (--force)' : ''}:`);
  console.table(targets.map((t) => ({ ytId: t.ytId, hadClip: t.has })));

  if (!EXECUTE) {
    console.log('\nDry run - nothing downloaded or written. Re-run with --execute.');
    await conn.close();
    return;
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vidprev-'));
  let ok = 0;
  let failed = 0;
  try {
    for (const t of targets) {
      const raw = path.join(tmpDir, `${t.ytId}.src`);
      try {
        process.stdout.write(`  ${t.ytId}: downloading... `);
        downloadStream(t.url, raw);
        // yt-dlp may append a container ext - find the actual file.
        const actual = fs.existsSync(raw)
          ? raw
          : fs.readdirSync(tmpDir).map((f) => path.join(tmpDir, f)).find((f) => f.startsWith(raw));
        if (!actual) throw new Error('yt-dlp produced no file');
        process.stdout.write('uploading... ');
        const clipUrl = await uploadPreview(actual, t.ytId);
        await videos.updateOne(
          { _id: t._id },
          { $set: { previewClipUrl: clipUrl, updatedAt: new Date() } }
        );
        fs.rmSync(actual, { force: true });
        console.log(`ok -> ${clipUrl}`);
        ok++;
      } catch (e) {
        console.log(`FAILED: ${e.message}`);
        failed++;
      }
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    await conn.close();
  }

  console.log(`\nDone. ${ok} generated, ${failed} failed.`);
  if (failed) process.exitCode = 1;
}

main().catch((err) => {
  console.error('Preview generation failed:', err);
  process.exit(1);
});
