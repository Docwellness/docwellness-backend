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
 * The password is read from a masked terminal prompt, never a CLI arg or
 * env var, so it never ends up in shell history or process listings.
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
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    // Mask typed characters with '*' instead of echoing the real password.
    const originalWrite = rl._writeToOutput;
    rl._writeToOutput = function (chunk) {
      originalWrite.call(rl, chunk.replace(/./g, '*'));
    };
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

async function main() {
  console.log(`Signing in as ${email} ...`);
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
