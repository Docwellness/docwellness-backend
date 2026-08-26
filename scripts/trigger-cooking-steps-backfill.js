/**
 * Guided, step-by-step HTTP client for
 * POST /api/dietician/recipes/backfill-cooking-steps
 * (controllers/dietician/uploadRecipieController.js's backfillCookingSteps).
 *
 * Deliberately does NOT open a database connection or need MONGODB_URI at
 * all - prod's MongoDB is self-hosted on a private-subnet-only Oracle VM
 * (docs/db-migration-oracle.md) with no public IP, unreachable from outside
 * Coolify's network. The already-running app process holds the correct DB
 * connection for wherever it's actually deployed, so this just calls that
 * app's own HTTPS API as the dietician, the same way the dietician app
 * itself would - no Mongo/Coolify-terminal access needed, just a normal
 * authenticated API request.
 *
 * Steps this script walks through, in order:
 *   1. Validate API_BASE_URL / DIETICIAN_ACCESS_TOKEN are set.
 *   2. Dry run: POST with execute=false, print every recipe's generated
 *      steps and a total/updated/failed summary. Nothing is written yet.
 *   3. If there's nothing to fix, or the dry run's request itself failed,
 *      stop here.
 *   4. Ask for interactive confirmation (unless --yes was passed).
 *   5. Execute: POST with execute=true, print the final summary.
 *
 * Requires (as either a CLI flag or an env var - see Usage below; the flag
 * wins if both are given):
 *   API_BASE_URL / --api-base-url=   e.g. https://api.docwellness.fit (no trailing slash)
 *   DIETICIAN_ACCESS_TOKEN / --token= a valid Supabase access token for the
 *                          target dietician account (the same bearer token
 *                          the dietician app sends as `Authorization:
 *                          Bearer <token>`) - grab one from an already-
 *                          logged-in session (e.g. the dietician app's
 *                          network inspector) rather than scripting a
 *                          fresh login here, which would require handling
 *                          the dietician's Supabase password directly.
 *
 * CLI flags exist alongside the env vars specifically because Coolify's
 * one-off command/job runner has already been seen (see the removed
 * scripts/run-catalog-migration.js's own history) not to reliably pass
 * `VAR=value` shell-style prefixes into the executed process - a single
 * command line with explicit flags sidesteps that entirely.
 *
 * Usage:
 *   node scripts/trigger-cooking-steps-backfill.js \
 *     --api-base-url=https://api.docwellness.fit --token=eyJ...
 *       # runs the dry run, shows a preview, asks "proceed? (yes/no)"
 *
 *   ... --yes    # same, but skips the confirmation prompt (for CI/jobs -
 *                # REQUIRED for a non-interactive runner like a Coolify
 *                # one-off job, which has no terminal to answer "yes" to)
 *   ... --dry-run   # preview only, never writes, no prompt
 *
 *   Equivalently, via env vars instead of flags:
 *   API_BASE_URL=https://... DIETICIAN_ACCESS_TOKEN=eyJ... \
 *     node scripts/trigger-cooking-steps-backfill.js
 */

const readline = require('readline');

const flag = (name) => {
  const arg = process.argv.find((a) => a.startsWith(`--${name}=`));
  return arg ? arg.slice(name.length + 3) : null;
};

const SKIP_CONFIRM = process.argv.includes('--yes') || process.argv.includes('-y');
const DRY_RUN_ONLY = process.argv.includes('--dry-run');
const API_BASE_URL = flag('api-base-url') || process.env.API_BASE_URL;
const DIETICIAN_ACCESS_TOKEN = flag('token') || process.env.DIETICIAN_ACCESS_TOKEN;

function printResults(body) {
  for (const r of body.results) {
    if (r.error) {
      console.log(`FAILED "${r.name}": ${r.error}`);
    } else {
      console.log(`"${r.name}"`);
      r.steps.forEach((s, i) => console.log(`  ${i + 1}. ${s}`));
    }
  }
}

async function callBackfillEndpoint(execute) {
  const url = `${API_BASE_URL.replace(/\/$/, '')}/api/dietician/recipes/backfill-cooking-steps?execute=${execute}`;
  console.log(`POST ${url}`);

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${DIETICIAN_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
  });

  const body = await response.json().catch(() => null);
  if (!response.ok) {
    console.error(`Request failed: ${response.status} ${response.statusText}`);
    console.error(JSON.stringify(body, null, 2));
    return null;
  }
  return body;
}

function askYesNo(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'yes');
    });
  });
}

async function main() {
  console.log('=== Step 1/5: checking configuration ===');
  if (!API_BASE_URL) {
    throw new Error(
      'API base URL is required: pass --api-base-url=https://api.docwellness.fit or set API_BASE_URL'
    );
  }
  if (!DIETICIAN_ACCESS_TOKEN) {
    throw new Error('Dietician token is required: pass --token=eyJ... or set DIETICIAN_ACCESS_TOKEN');
  }
  console.log(`API_BASE_URL=${API_BASE_URL}`);
  console.log('DIETICIAN_ACCESS_TOKEN=<set>\n');

  console.log('=== Step 2/5: dry run (nothing written yet) ===');
  const dryRun = await callBackfillEndpoint(false);
  if (!dryRun) {
    process.exitCode = 1;
    return;
  }
  printResults(dryRun);
  console.log(
    `\nDry run summary: total=${dryRun.summary.total} would-update=${dryRun.summary.total - dryRun.summary.failed} would-fail=${dryRun.summary.failed}`
  );

  console.log('\n=== Step 3/5: deciding whether to continue ===');
  if (dryRun.summary.total === 0) {
    console.log('Nothing to backfill - every recipe already has cooking steps. Done.');
    return;
  }
  if (DRY_RUN_ONLY) {
    console.log('--dry-run passed - stopping here, nothing was written.');
    return;
  }

  console.log('\n=== Step 4/5: confirmation ===');
  let proceed = SKIP_CONFIRM;
  if (!proceed && !process.stdin.isTTY) {
    // A non-interactive runner (Coolify one-off job, CI) has no terminal to
    // answer a prompt - readline would just hang or read immediate EOF as
    // "no", silently stopping with no obvious explanation. Fail loudly
    // instead, telling the operator exactly what flag fixes it.
    throw new Error('No interactive terminal to confirm on - re-run with --yes to proceed non-interactively.');
  }
  if (!proceed) {
    proceed = await askYesNo(
      `Write these ${dryRun.summary.total - dryRun.summary.failed} recipe(s)' steps to the database? Type "yes" to proceed: `
    );
  } else {
    console.log('--yes passed - skipping confirmation prompt.');
  }
  if (!proceed) {
    console.log('Not confirmed - stopping here, nothing was written.');
    return;
  }

  console.log('\n=== Step 5/5: executing (writing to the database) ===');
  const executed = await callBackfillEndpoint(true);
  if (!executed) {
    process.exitCode = 1;
    return;
  }
  console.log(
    `\n=== DONE === total=${executed.summary.total} updated=${executed.summary.updated} failed=${executed.summary.failed}`
  );
}

main().catch((err) => {
  console.error('FATAL:', err.message);
  process.exit(1);
});
