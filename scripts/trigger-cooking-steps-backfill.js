/**
 * Thin HTTP client for POST /api/dietician/recipes/backfill-cooking-steps
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
 * Requires:
 *   API_BASE_URL           e.g. https://api.docwellness.fit (no trailing slash)
 *   DIETICIAN_ACCESS_TOKEN a valid Supabase access token for the target
 *                          dietician account (the same bearer token the
 *                          dietician app sends as `Authorization: Bearer
 *                          <token>`) - grab one from an already-logged-in
 *                          session (e.g. the dietician app's network
 *                          inspector) rather than scripting a fresh login
 *                          here, which would require handling the
 *                          dietician's Supabase password directly.
 *
 * Usage:
 *   API_BASE_URL=https://... DIETICIAN_ACCESS_TOKEN=eyJ... \
 *     node scripts/trigger-cooking-steps-backfill.js            # dry run
 *   API_BASE_URL=https://... DIETICIAN_ACCESS_TOKEN=eyJ... \
 *     node scripts/trigger-cooking-steps-backfill.js --execute   # write
 */

const EXECUTE = process.argv.includes('--execute');
const API_BASE_URL = process.env.API_BASE_URL;
const DIETICIAN_ACCESS_TOKEN = process.env.DIETICIAN_ACCESS_TOKEN;

async function main() {
  if (!API_BASE_URL) throw new Error('API_BASE_URL env var is required (e.g. https://api.docwellness.fit)');
  if (!DIETICIAN_ACCESS_TOKEN) throw new Error('DIETICIAN_ACCESS_TOKEN env var is required');

  const url = `${API_BASE_URL.replace(/\/$/, '')}/api/dietician/recipes/backfill-cooking-steps?execute=${EXECUTE}`;
  console.log(EXECUTE ? '=== EXECUTING cooking-step backfill (via API) ===' : '=== DRY RUN (pass --execute to write) ===');
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
    process.exitCode = 1;
    return;
  }

  for (const r of body.results) {
    if (r.error) {
      console.log(`FAILED "${r.name}": ${r.error}`);
    } else {
      console.log(`"${r.name}"`);
      r.steps.forEach((s, i) => console.log(`  ${i + 1}. ${s}`));
    }
  }

  console.log(
    `\n=== ${EXECUTE ? 'DONE' : 'DRY RUN DONE'} === total=${body.summary.total} updated=${body.summary.updated} failed=${body.summary.failed}`
  );
}

main().catch((err) => {
  console.error('FATAL:', err.message);
  process.exit(1);
});
