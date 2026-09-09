/**
 * Generates the short muted MP4 preview clips the user app's "Videos for you"
 * rail autoplays inline (via native video_player, not the YouTube webview).
 *
 * For each YouTube Video doc missing a previewClipUrl:
 *   1. yt-dlp grabs a <=720p H.264/mp4 video-only stream (no ffmpeg / no
 *      audio merge). yt-dlp is found via $YT_DLP_PATH, then `python -m
 *      yt_dlp`, then `yt-dlp` on PATH, and failing all that its standalone
 *      binary is downloaded to a temp dir (the deployed image is Node-only).
 *   2. Cloudinary trims to the first ~6s, scales to 480w, drops audio,
 *      re-encodes H.264, returns a CDN mp4 URL.
 *   3. That URL is written back to Video.previewClipUrl.
 *
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
const https = require('https');
const { execFileSync } = require('child_process');
const mongoose = require('mongoose');
const connectDB = require('../config/database');
const cloudinary = require('../config/cloudinary');

const EXECUTE = process.argv.includes('--execute');
const FORCE = process.argv.includes('--force');
const idArg = process.argv.find((a) => a.startsWith('--id='));
const ONLY_ID = idArg ? idArg.split('=')[1] : null;

const CLIP_SECONDS = 6;
const CLOUDINARY_FOLDER = 'docwellness/video-previews';

const ytIdFromUrl = (url = '') => {
  const m = String(url).match(
    /(?:shorts\/|watch\?v=|youtu\.be\/|embed\/)([a-zA-Z0-9_-]{11})/
  );
  return m ? m[1] : null;
};

// ── yt-dlp resolver ─────────────────────────────────────────────────────────
// The deployed backend image is Node-only (no python, no yt-dlp). Rather than
// bloat it, fall back to fetching yt-dlp's standalone binary into a temp dir
// on first run. Order: $YT_DLP_PATH, `python -m yt_dlp`, `yt-dlp` on PATH,
// then download.
function tryVersion(file, args) {
  try {
    execFileSync(file, [...args, '--version'], {
      stdio: ['ignore', 'ignore', 'ignore'],
      timeout: 15000,
    });
    return true;
  } catch (_) {
    return false;
  }
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'docwellness-script' } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        return download(res.headers.location, dest).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`GET ${url} -> ${res.statusCode}`));
      }
      const out = fs.createWriteStream(dest);
      res.pipe(out);
      out.on('finish', () => out.close(resolve));
      out.on('error', reject);
    });
    req.on('error', reject);
  });
}

async function resolveYtDlp() {
  if (process.env.YT_DLP_PATH) {
    return { file: process.env.YT_DLP_PATH, pre: [] };
  }
  const python = process.env.PYTHON_BIN || 'python';
  if (tryVersion(python, ['-m', 'yt_dlp'])) return { file: python, pre: ['-m', 'yt_dlp'] };
  if (tryVersion('yt-dlp', [])) return { file: 'yt-dlp', pre: [] };
  if (tryVersion('yt-dlp_linux', [])) return { file: 'yt-dlp_linux', pre: [] };

  const asset =
    process.platform === 'win32'
      ? 'yt-dlp.exe'
      : process.platform === 'darwin'
        ? 'yt-dlp_macos'
        : 'yt-dlp_linux';
  const url = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${asset}`;

  // /tmp is often mounted noexec in hardened containers, so try a few places
  // the binary can actually run from - the app dir first (the overlay fs).
  const dirs = [
    process.env.YT_DLP_DIR,
    path.join(process.cwd(), '.yt-dlp-cache'),
    path.join(os.homedir() || '', '.cache', 'docwellness-yt-dlp'),
    path.join(os.tmpdir(), 'docwellness-yt-dlp'),
  ].filter(Boolean);

  let lastErr;
  for (const dir of dirs) {
    const bin = path.join(dir, asset);
    try {
      fs.mkdirSync(dir, { recursive: true });
      if (!fs.existsSync(bin) || fs.statSync(bin).size < 1_000_000) {
        console.log(`yt-dlp not found - downloading ${asset} to ${dir} ...`);
        await download(url, bin);
        if (process.platform !== 'win32') fs.chmodSync(bin, 0o755);
      }
      if (tryVersion(bin, [])) return { file: bin, pre: [] };
      lastErr = new Error(`not runnable from ${dir} (noexec?)`);
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(
    `could not get a runnable yt-dlp (${lastErr && lastErr.message}). ` +
      `Install it in the image, or set YT_DLP_PATH / YT_DLP_DIR.`
  );
}

let YT_DLP = null;

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

function downloadStream(youtubeUrl, outPattern) {
  // <=720p, H.264-in-mp4 first (what Cloudinary ingests most reliably), then
  // any mp4, then anything. Video-only where possible so yt-dlp never needs
  // ffmpeg to mux; Cloudinary does the trim + transcode + audio strip.
  const fmt = [
    'bv*[height<=720][ext=mp4][vcodec^=avc1]',
    'bv*[height<=720][ext=mp4]',
    'bv*[height<=720]',
    'b[height<=720][ext=mp4]',
    'b[height<=720]',
    'b',
  ].join('/');
  execFileSync(
    YT_DLP.file,
    [
      ...YT_DLP.pre,
      '--no-playlist',
      '--no-warnings',
      '--quiet',
      '-f',
      fmt,
      '-o',
      outPattern, // must contain %(ext)s so the file keeps a real extension
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

  YT_DLP = await resolveYtDlp();
  console.log(`Using yt-dlp: ${[YT_DLP.file, ...YT_DLP.pre].join(' ')}`);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vidprev-'));
  let ok = 0;
  let failed = 0;
  try {
    for (const t of targets) {
      try {
        process.stdout.write(`  ${t.ytId}: downloading... `);
        downloadStream(t.url, path.join(tmpDir, `${t.ytId}.%(ext)s`));
        // yt-dlp fills in the real container extension - find that file.
        const actual = fs
          .readdirSync(tmpDir)
          .filter((f) => f.startsWith(`${t.ytId}.`))
          .map((f) => path.join(tmpDir, f))[0];
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
