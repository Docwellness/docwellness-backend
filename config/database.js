const mongoose = require('mongoose');
const dns = require('dns');

let usernameIndexCleanupAttempted = false;

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
      // multiple things connect to the same free-tier M0 cluster (500
      // connections total): a handful of concurrent Vercel serverless
      // instances, each opening their own pool, can exhaust the entire
      // cluster limit on their own. Capped low here since this app - even
      // the persistent VPS/Coolify process - never legitimately needs many
      // concurrent in-flight queries at this scale.
      return await mongoose.connect(uri, { maxPoolSize: 10 });
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
  return conn.connection;
};

module.exports = connectDB;
