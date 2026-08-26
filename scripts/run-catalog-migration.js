/**
 * One-shot wrapper for scripts/migrate-dev-catalog-to-prod.js, for
 * environments (e.g. a Coolify one-off command runner) that don't preserve
 * `export`ed shell variables between separate invocations.
 *
 * Captures whatever MONGODB_URI this process is already running with
 * (prod's own connection string, when run from prod's environment) as
 * PROD_MONGODB_URI, then overrides MONGODB_URI to dev's connection string,
 * all inside this one Node process - so it works the same whether the
 * surrounding shell keeps state between commands or not.
 *
 * DEV_MONGODB_URI can be set to override the hardcoded dev connection
 * string below if it's ever rotated; otherwise this is the known dev value
 * as of the fooditem-nutrition-tier1-gap-closure / recipe-database work.
 *
 * Usage (same flags as migrate-dev-catalog-to-prod.js):
 *   node scripts/run-catalog-migration.js --prod-dietician-id=<id>            # dry run
 *   node scripts/run-catalog-migration.js --prod-dietician-id=<id> --execute  # actually write
 */
const DEV_MONGODB_URI =
  process.env.DEV_MONGODB_URI ||
  'mongodb+srv://docwellnessfit_db_user:Xy3RvhFaLgSKvfmd@m0.rbkj5va.mongodb.net/docwellness?appName=M0';

if (!process.env.MONGODB_URI) {
  console.error('MONGODB_URI is not set in this environment - expected it to already be prod\'s own connection string.');
  process.exit(1);
}

process.env.PROD_MONGODB_URI = process.env.MONGODB_URI;
process.env.MONGODB_URI = DEV_MONGODB_URI;

require('./migrate-dev-catalog-to-prod.js');
