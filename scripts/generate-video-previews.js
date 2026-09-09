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
 *   set PROD_MONGODB_URI, or --use-default-uri in the deployed container
 *   (uses that env's MONGODB_URI). DRY RUN unless --execute.
 *
 * Usage (all-in-one - needs yt-dlp AND DB reachable from the same box):
 *   node scripts/generate-video-previews.js [--use-default-uri] [--execute]
 *   ... [--force]  (redo all)   [--id=WxcuatHGznw]  (just one)
 *
 * Usage (split - when the container's fs is noexec so yt-dlp can't run there):
 *   laptop  (yt-dlp, no DB):   --emit=clips.json --ids=id1,id2,id3
 *   container (DB, no yt-dlp):  --apply --use-default-uri --execute
 *     ^ bare --apply reads the Cloudinary preview folder directly and
 *       rebuilds the delivery URLs - nothing to copy over. (Or point it at
 *       the emitted file / inline JSON: --apply=clips.json / --apply='{..}')
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
const argVal = (name) => {
  const a = process.argv.find((x) => x.startsWith(`${name}=`));
  return a ? a.slice(name.length + 1) : null;
};
const ONLY_ID = argVal('--id');
// Split mode for containers where yt-dlp can't run (noexec fs):
//   laptop:    ... --emit=clips.json --ids=a,b,c        (yt-dlp + Cloudinary)
//   container: ... --apply --use-default-uri --execute  (bare --apply reads
//              the Cloudinary folder directly - no file to copy over)
const EMIT = argVal('--emit');
const APPLY = process.argv.includes('--apply') ? (argVal('--apply') ?? '') : null;
const IDS_ARG = argVal('--ids');

const CLIP_SECONDS = 6;
const CLOUDINARY_FOLDER = 'docwellness/video-previews';

// The one derivative every clip is delivered through: first 6s, 480w, no
// audio, H.264. Source is already 9:16 so c_scale keeps the frame whole.
// (gravity:auto / crop:fill silently void the eager on video - don't.)
const CLIP_TX = {
  start_offset: '0',
  end_offset: String(CLIP_SECONDS),
  width: 480,
  crop: 'scale',
  video_codec: 'h264',
  audio_codec: 'none',
  quality: 'auto:eco',
};

// Deterministic delivery URL for a preview asset - lets --apply rebuild the
// URLs straight from the Cloudinary folder listing, no file to copy around.
const clipUrlFor = (publicId) =>
  cloudinary.url(publicId, {
    resource_type: 'video',
    secure: true,
    format: 'mp4',
    transformation: [CLIP_TX],
    force_version: false, // no /v1/ segment - deliver the latest
    analytics: false, // no ?_a= tracking param
  });

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
    eager: [CLIP_TX],
  });
  const eager = res.eager && res.eager[0];
  if (!eager || !eager.secure_url) {
    throw new Error('Cloudinary upload returned no eager derivative');
  }
  return eager.secure_url;
}

// ── --apply: write previewClipUrl into the DB. No yt-dlp. The {ytId: url}
// map comes from (in priority order): --apply=file.json, --apply={...inline},
// or - bare --apply - the Cloudinary preview folder itself. ─────────────────
async function buildApplyMap() {
  const raw = (APPLY || '').trim();
  if (raw.startsWith('{')) return JSON.parse(raw);
  if (raw) return JSON.parse(fs.readFileSync(raw, 'utf8'));

  // Bare --apply: list what generate/emit already uploaded and rebuild URLs.
  console.log(`Listing Cloudinary folder "${CLOUDINARY_FOLDER}/" ...`);
  const map = {};
  let next;
  do {
    const page = await cloudinary.api.resources({
      resource_type: 'video',
      type: 'upload',
      prefix: `${CLOUDINARY_FOLDER}/`,
      max_results: 100,
      next_cursor: next,
    });
    for (const r of page.resources) {
      const ytId = r.public_id.split('/').pop();
      if (/^[a-zA-Z0-9_-]{11}$/.test(ytId)) map[ytId] = clipUrlFor(r.public_id);
    }
    next = page.next_cursor;
  } while (next);
  return map;
}

async function runApply() {
  const map = await buildApplyMap();
  const entries = Object.entries(map).filter(([, u]) => /^https?:\/\//.test(u));
  console.log(
    `${EXECUTE ? '=== APPLYING' : '=== DRY RUN (--apply,'} ${entries.length} clip URL(s) ${EXECUTE ? '===' : ') ==='}`
  );
  const conn = await openConnection();
  console.log(`Connected to DB "${conn.name}" @ ${conn.host}:${conn.port}`);
  const videos = conn.collection('videos');
  let ok = 0;
  try {
    for (const [ytId, url] of entries) {
      const q = { source: 'YouTube', youtubeUrl: new RegExp(escapeRe(ytId)) };
      if (!EXECUTE) {
        const n = await videos.countDocuments(q);
        console.log(`  ${ytId}: matches ${n} doc(s) -> ${url}`);
        continue;
      }
      const r = await videos.updateMany(q, {
        $set: { previewClipUrl: url, updatedAt: new Date() },
      });
      console.log(`  ${ytId}: updated ${r.modifiedCount} -> ${url}`);
      ok += r.modifiedCount;
    }
  } finally {
    await conn.close();
  }
  console.log(`\n${EXECUTE ? `Applied to ${ok} doc(s).` : 'Dry run - re-run with --execute.'}`);
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function main() {
  if (APPLY !== null) return runApply();

  if (
    !process.env.CLOUDINARY_CLOUD_NAME ||
    !process.env.CLOUDINARY_API_KEY ||
    !process.env.CLOUDINARY_API_SECRET
  ) {
    console.error('CLOUDINARY_* env vars are required.');
    process.exit(1);
  }

  console.log(
    EMIT
      ? `=== EMIT mode -> ${EMIT} (no DB writes) ===`
      : EXECUTE
        ? '=== EXECUTING preview generation ==='
        : '=== DRY RUN (pass --execute) ==='
  );

  // EMIT with an explicit id list needs no DB (laptop can't reach a private
  // prod host). Otherwise pull the target list from the DB.
  let targets;
  let conn = null;
  if (EMIT && IDS_ARG) {
    targets = IDS_ARG.split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((ytId) => ({
        ytId,
        url: `https://www.youtube.com/shorts/${ytId}`,
        has: false,
      }));
    console.log(`\n${targets.length} id(s) from --ids:`);
    console.table(targets.map((t) => ({ ytId: t.ytId })));
    return runGenerate(targets, null);
  }

  conn = await openConnection();
  console.log(
    `Connected to DB "${conn.name}" @ ${conn.host}:${conn.port}` +
      (USE_DEFAULT_URI ? '  (via MONGODB_URI)' : '  (via PROD_MONGODB_URI)')
  );
  const videos = conn.collection('videos');

  const filter = { source: 'YouTube', youtubeUrl: { $regex: /^https?:\/\// } };
  if (!FORCE) filter.$or = [{ previewClipUrl: { $exists: false } }, { previewClipUrl: '' }];
  const docs = await videos.find(filter).toArray();

  targets = docs
    .map((d) => ({ _id: d._id, ytId: ytIdFromUrl(d.youtubeUrl), url: d.youtubeUrl, has: !!d.previewClipUrl }))
    .filter((t) => t.ytId && (!ONLY_ID || t.ytId === ONLY_ID));

  console.log(`\n${targets.length} video(s) to process${FORCE ? ' (--force)' : ''}:`);
  console.table(targets.map((t) => ({ ytId: t.ytId, hadClip: t.has })));

  if (!EXECUTE && !EMIT) {
    console.log('\nDry run - nothing downloaded or written. Re-run with --execute.');
    await conn.close();
    return;
  }

  await runGenerate(targets, conn);
}

// yt-dlp + Cloudinary for each target. Writes previewClipUrl to the DB when
// `conn` is given, otherwise (EMIT) collects a {ytId: url} map to a file.
async function runGenerate(targets, conn) {
  const videos = conn ? conn.collection('videos') : null;

  YT_DLP = await resolveYtDlp();
  console.log(`Using yt-dlp: ${[YT_DLP.file, ...YT_DLP.pre].join(' ')}`);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vidprev-'));
  const emitted = {};
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
        if (videos) {
          await videos.updateMany(
            { source: 'YouTube', youtubeUrl: new RegExp(escapeRe(t.ytId)) },
            { $set: { previewClipUrl: clipUrl, updatedAt: new Date() } }
          );
        }
        emitted[t.ytId] = clipUrl;
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
    if (conn) await conn.close();
  }

  if (EMIT) {
    fs.writeFileSync(EMIT, JSON.stringify(emitted, null, 2));
    console.log(`\nWrote ${Object.keys(emitted).length} clip URL(s) to ${EMIT}`);
    console.log(
      'Now, in the container:  node scripts/generate-video-previews.js ' +
        `--apply=${path.basename(EMIT)} --use-default-uri --execute`
    );
  }
  console.log(`\nDone. ${ok} generated, ${failed} failed.`);
  if (failed) process.exitCode = 1;
}

main().catch((err) => {
  console.error('Preview generation failed:', err);
  process.exit(1);
});
