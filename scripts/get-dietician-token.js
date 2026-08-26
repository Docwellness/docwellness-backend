/**
 * Prints a real Supabase access token for a dietician account, for pasting
 * into scripts/trigger-cooking-steps-backfill.js's --token= flag (or any
 * other script that needs to call this app's API as an authenticated
 * dietician).
 *
 * Uses utils/supabaseAuth.js's existing signInWithPassword - the exact
 * server-side equivalent of the dietician app's own login - rather than
 * pulling a token out of a logged-in session's network traffic. Needs only
 * SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY (already in .env for local runs);
 * no MongoDB connection at all, and Supabase itself is a public API, so
 * this can be run from anywhere - it does NOT need to run inside Coolify.
 *
 * The password is read from a plain terminal prompt (visible as you type -
 * see below), never a CLI arg or env var, so it at least never ends up in
 * shell history or process listings. An earlier version tried to mask the
 * input by monkey-patching readline's internal _writeToOutput to draw
 * asterisks - that's a known-fragile trick (breaks readline's own cursor
 * tracking) and hung indefinitely in real interactive use; only a plain
 * (piped, non-interactive) test run had validated it, which takes a
 * different code path entirely and never exercised real typing. Removed in
 * favor of the vanilla readline.question this file's own --yes confirmation
 * prompt already uses successfully elsewhere.
 *
 * Usage:
 *   node scripts/get-dietician-token.js [email]
 *   (email defaults to tejasvini@docwellness.fit)
 */
require('dotenv').config();
const readline = require('readline');

const DEFAULT_EMAIL = 'tejasvini@docwellness.fit';
const email = process.argv[2] || DEFAULT_EMAIL;

function promptPassword(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

async function main() {
  console.log(`Signing in as ${email} ...`);
  console.log('(password will be visible as you type - make sure no one is looking over your shoulder)');
  const password = await promptPassword('Password: ');

  const { signInWithPassword } = require('../utils/supabaseAuth');
  const session = await signInWithPassword(email, password);

  console.log('\nSigned in.');
  console.log(`Access token (expires ${new Date(session.expires_at * 1000).toISOString()}):\n`);
  console.log(session.access_token);
  console.log('\nUse it like:');
  console.log(
    `  node scripts/trigger-cooking-steps-backfill.js --api-base-url=https://api.docwellness.fit --token=${session.access_token.slice(0, 12)}... --yes`
  );
}

main().catch((err) => {
  console.error('FATAL:', err.message);
  // process.exitCode (not process.exit()) - an abrupt exit() right after
  // closing the readline/stdin handle used for the masked password prompt
  // crashes with a native libuv assertion on Windows (win\async.c);
  // setting exitCode and letting the event loop drain naturally avoids it.
  process.exitCode = 1;
});
