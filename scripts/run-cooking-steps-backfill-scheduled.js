/**
 * Fully non-interactive version of the cooking-steps backfill, for running
 * as a Coolify Scheduled Task / one-off job - no readline prompt of any
 * kind (there's no terminal attached to answer one), so every input comes
 * from env vars set on the Coolify resource, not the command line (see
 * scripts/run-catalog-migration.js's removed history: Coolify's runner
 * doesn't reliably pass shell-style `VAR=value` prefixes typed into the
 * command field - a persisted resource env var is the reliable path).
 *
 * Combines what get-dietician-token.js + trigger-cooking-steps-backfill.js
 * do interactively into one unattended run: sign in, dry run, and (only if
 * explicitly told to) execute - all in a single process, no token to copy
 * between steps.
 *
 * Required Coolify resource env vars (set these in Coolify's UI, NOT in
 * the scheduled task's command field):
 *   DIETICIAN_EMAIL      the dietician's real login email
 *   DIETICIAN_PASSWORD   her real password
 *   API_BASE_URL         defaults to http://localhost:<PORT|5000> - correct
 *                        if this task runs inside the already-running app
 *                        container (the normal case for a Coolify Scheduled
 *                        Task on an existing resource); override only if it
 *                        actually runs in a separate container without the
 *                        app server up, e.g. https://api.docwellness.fit
 *   EXECUTE               'true' to actually write; anything else (or
 *                        unset) stays a dry run that only previews and logs
 *                        what it would do. Defaults to dry-run-only as a
 *                        safety net against an accidental/duplicate
 *                        schedule run - flip to 'true' deliberately once
 *                        you've reviewed a dry-run's output.
 *
 * SECURITY: this needs the dietician's real password sitting in Coolify's
 * env vars for as long as DIETICIAN_PASSWORD is set there - a standing
 * credential exposure, worse than a one-time interactive password prompt.
 * This backfill is a ONE-TIME fix (idempotent - it only ever touches
 * recipes still missing instructions, so a second run is a safe no-op).
 * Once it's confirmed updated=N/failed=0 with EXECUTE=true, remove
 * DIETICIAN_EMAIL/DIETICIAN_PASSWORD from Coolify and rotate her password.
 * Do not leave this configured as a permanently recurring schedule.
 */
const { signInWithPassword } = require('../utils/supabaseAuth');

const DIETICIAN_EMAIL = process.env.DIETICIAN_EMAIL;
const DIETICIAN_PASSWORD = process.env.DIETICIAN_PASSWORD;
const API_BASE_URL = process.env.API_BASE_URL || `http://localhost:${process.env.PORT || 5000}`;
const EXECUTE = process.env.EXECUTE === 'true';

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

async function callBackfillEndpoint(accessToken, execute) {
  const url = `${API_BASE_URL.replace(/\/$/, '')}/api/dietician/recipes/backfill-cooking-steps?execute=${execute}`;
  console.log(`POST ${url}`);

  const response = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
  });

  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status} ${response.statusText} - ${JSON.stringify(body)}`);
  }
  return body;
}

async function main() {
  console.log('=== Step 1/4: checking configuration ===');
  if (!DIETICIAN_EMAIL) throw new Error('DIETICIAN_EMAIL env var is required');
  if (!DIETICIAN_PASSWORD) throw new Error('DIETICIAN_PASSWORD env var is required');
  console.log(`DIETICIAN_EMAIL=${DIETICIAN_EMAIL}`);
  console.log(`API_BASE_URL=${API_BASE_URL}`);
  console.log(`EXECUTE=${EXECUTE}`);

  console.log('\n=== Step 2/4: signing in ===');
  const session = await signInWithPassword(DIETICIAN_EMAIL, DIETICIAN_PASSWORD);
  console.log('Signed in.');

  console.log('\n=== Step 3/4: dry run (nothing written yet) ===');
  const dryRun = await callBackfillEndpoint(session.access_token, false);
  printResults(dryRun);
  console.log(
    `\nDry run summary: total=${dryRun.summary.total} would-update=${dryRun.summary.total - dryRun.summary.failed} would-fail=${dryRun.summary.failed}`
  );

  if (dryRun.summary.total === 0) {
    console.log('\nNothing to backfill - every recipe already has cooking steps. Done.');
    return;
  }
  if (!EXECUTE) {
    console.log('\nEXECUTE is not "true" - stopping here, nothing was written. Set EXECUTE=true to write.');
    return;
  }

  console.log('\n=== Step 4/4: executing (writing to the database) ===');
  const executed = await callBackfillEndpoint(session.access_token, true);
  console.log(
    `\n=== DONE === total=${executed.summary.total} updated=${executed.summary.updated} failed=${executed.summary.failed}`
  );
}

main().catch((err) => {
  console.error('FATAL:', err.message);
  process.exitCode = 1;
});
