const mongoose = require('mongoose');
const dns = require('dns');
const fs = require('fs');
const os = require('os');
const path = require('path');

let usernameIndexCleanupAttempted = false;
let cachedTlsCAFile;

// Prod connects over TLS to the self-hosted instance's private CA (see
// docs/db-migration-oracle.md); dev's Atlas mongodb+srv:// URI already
// negotiates TLS on its own and needs no custom CA, so this stays unset
// there and connectWithRetry falls back to plain options - same
// "optional integration degrades gracefully" convention as utils/push.js's
// FCM_SERVICE_ACCOUNT_BASE64. Written to a tmp file once per process and
// reused, rather than decoded fresh on every retry attempt.
function resolveTlsCAFile() {
  if (cachedTlsCAFile !== undefined) return cachedTlsCAFile;
  const base64 = process.env.MONGODB_TLS_CA_BASE64;
  if (!base64) {
    cachedTlsCAFile = null;
    return cachedTlsCAFile;
  }
  const caPath = path.join(os.tmpdir(), 'mongodb-ca.pem');
  fs.writeFileSync(caPath, Buffer.from(base64, 'base64'));
  cachedTlsCAFile = caPath;
  return cachedTlsCAFile;
}

// Self-healing cleanup for a stale unique index left over from the
// `username` field's removal (models/User.js no longer defines it at all -
// see git history). Every new User document now has no `username` field,
// which Mongo's old unique index still treats as `null` - so the second
// registration onward collides on that shared null and fails with a
// duplicate-key error. Runs here (using the server's own already-correct
// connection) rather than as a manually-triggered migration script, since
// there's no reliable way to run one-off scripts against whichever
// environment (dev/prod) actually ends up deployed - this way it just
// self-heals wherever this code runs. Guarded to attempt once per warm
// process (cheap no-op via the try/catch once the index is actually gone,
// so repeat cold starts on serverless cost one harmless lookup each).
async function dropStaleUsernameIndex(connection) {
  if (usernameIndexCleanupAttempted) return;
  usernameIndexCleanupAttempted = true;
  try {
    const collection = connection.db.collection('users');
    const indexes = await collection.indexes();
    const usernameIndex = indexes.find((idx) => idx.key && idx.key.username);
    if (usernameIndex) {
      await collection.dropIndex(usernameIndex.name);
      console.log(`dropStaleUsernameIndex: dropped stale index ${usernameIndex.name}`);
    }
  } catch (error) {
    // Never fatal - a failed cleanup attempt shouldn't block server startup.
    console.error('dropStaleUsernameIndex: cleanup failed (non-fatal):', error.message);
  }
}

// Opt-in, run-once index reconciliation on boot. Mongoose's autoIndex
// (on by default) already CREATES any schema-declared index that's missing,
// but it never DROPS one that used to be declared and isn't anymore - e.g.
// when a narrow index is replaced by a wider compound one
// ({ dieticianId, status } -> { dieticianId, status, endDate }). Set
// SYNC_INDEXES_ON_BOOT=true for a single deploy to also drop those stale
// indexes (Model.syncIndexes() = create missing + drop no-longer-declared,
// idempotent, index metadata only, never touches documents), then remove
// the flag. This exists so the cleanup can happen without shell access to
// the container (scripts/maintenance/ensure-indexes.js does the same thing
// when a terminal IS available). Detached + best-effort: the server starts
// serving immediately, exactly as it would with autoIndex alone.
let syncIndexesAttempted = false;
function syncIndexesOnBoot() {
  if (syncIndexesAttempted || process.env.SYNC_INDEXES_ON_BOOT !== 'true') return;
  syncIndexesAttempted = true;
  const names = mongoose.modelNames();
  console.log(`syncIndexesOnBoot: reconciling indexes for ${names.length} model(s)...`);
  Promise.allSettled(
    names.map(async (name) => {
      try {
        const dropped = await mongoose.model(name).syncIndexes();
        if (dropped.length > 0) {
          console.log(`syncIndexesOnBoot: ${name} - dropped stale index(es): ${dropped.join(', ')}`);
        }
      } catch (err) {
        console.error(`syncIndexesOnBoot: ${name} - failed (non-fatal): ${err.message}`);
      }
    })
  ).then(() => console.log('syncIndexesOnBoot: done.'));
}

// A `mongodb+srv://` URI needs a DNS SRV lookup before the driver can even
// open a socket - seen intermittently failing with `querySrv ECONNREFUSED`
// on a freshly-spawned process (Node's bundled c-ares resolver occasionally
// drops the very first DNS query a cold process issues, particularly on
// Windows - confirmed the domain itself resolves fine via the OS's own
// `nslookup` in the same moment a Node process's own querySrv call fails).
// Retried a few times with a short backoff rather than treated as fatal -
// this is exactly the kind of transient blip a production process
// restarting after a network hiccup could also hit, not just a
// dev-environment quirk.
async function connectWithRetry(uri, { attempts = 3, delayMs = 800 } = {}) {
  let lastError;
  let triedFallbackDns = false;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      // The MongoDB driver defaults to maxPoolSize: 100 per connection when
      // unset - fine for a single long-running process, but ruinous once
      // multiple things connect to the same cluster. Dev (Vercel) still
      // points at the Atlas M0 free tier (500 connections total), where a
      // handful of concurrent serverless instances - each opening their own
      // pool - can exhaust the entire cluster limit on their own. Prod runs
      // against a dedicated self-hosted instance (see
      // docs/db-migration-oracle.md) with no such external cap, but 10 stays
      // the default here regardless since this app - even the persistent
      // VPS/Coolify process - never legitimately needs many concurrent
      // in-flight queries at this scale.
      const tlsCAFile = resolveTlsCAFile();
      const connectOptions = tlsCAFile
        ? { maxPoolSize: 10, tls: true, tlsCAFile }
        : { maxPoolSize: 10 };
      return await mongoose.connect(uri, connectOptions);
    } catch (error) {
      lastError = error;
      const isDnsSrvHiccup = error.code === 'ECONNREFUSED' && error.syscall === 'querySrv';
      if (!isDnsSrvHiccup) throw error;

      // Some environments have multiple/virtual network adapters (VPN,
      // Docker, etc.) whose DNS servers Node's resolver picks up
      // inconsistently per-process, even when the OS's own resolver (and
      // other already-running Node processes) succeed - confirmed exactly
      // this on a machine where the API server connected fine but a
      // separately-launched worker process's SRV lookup failed 3 attempts
      // in a row against its own default resolver. Falling back to known-
      // public DNS servers for the SRV lookup specifically resolves that
      // class of issue without touching the OS/network configuration.
      if (!triedFallbackDns) {
        triedFallbackDns = true;
        console.error(
          'connectDB: SRV DNS lookup failed on the default resolver, falling back to public DNS (8.8.8.8/1.1.1.1):',
          error.message
        );
        dns.setServers(['8.8.8.8', '1.1.1.1']);
        continue; // retry immediately with the new resolver, don't burn an attempt on backoff
      }

      if (attempt === attempts) throw error;
      console.error(
        `connectDB: attempt ${attempt}/${attempts} hit a transient SRV DNS lookup failure, retrying:`,
        error.message
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs * attempt));
    }
  }
  throw lastError;
}

/**
 * Database connection configuration.
 *
 * Reuses an existing connection when one is already open/connecting so this
 * is safe to call on every invocation of a serverless function (Vercel),
 * not just once at process startup like on the VPS.
 */
const connectDB = async () => {
  if (mongoose.connection.readyState === 1 || mongoose.connection.readyState === 2) {
    return mongoose.connection;
  }

  const conn = await connectWithRetry(process.env.MONGODB_URI);
  console.log(`MongoDB Connected: ${conn.connection.host}`);
  await dropStaleUsernameIndex(conn.connection);
  syncIndexesOnBoot();
  return conn.connection;
};

// Exposed alongside the default export so one-off scripts that need a
// second/manual mongoose connection (e.g. scripts/migrate-dev-catalog-to-prod.js,
// which holds a dev connection open on the default mongoose connection
// while also needing a separate prod connection via mongoose.createConnection)
// can build correct TLS options for that connection too, instead of each
// duplicating this resolution logic (or worse, silently omitting it - see
// that script's own history for what a raw mongoose.connect()/createConnection()
// against prod does without this: a misleading "self-signed certificate in
// certificate chain" error).
connectDB.resolveTlsCAFile = resolveTlsCAFile;

module.exports = connectDB;
