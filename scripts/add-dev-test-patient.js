/**
 * Zero-config: create ONE realistic DEV test patient, walked all the way to
 * "payment submitted, awaiting the dietician's review" - the exact state a
 * real patient is in right before a dietician opens "Create Diet Plan" for
 * them. Real Supabase identity, so the patient can also log into the
 * docwellness-user app.
 *
 * Usage (no flags, no --execute - it always writes):
 *   node scripts/add-dev-test-patient.js                   # Female patient
 *   node scripts/add-dev-test-patient.js --gender=Male
 *   node scripts/add-dev-test-patient.js --approve-payment # also mark the payment approved (-> status "Paid")
 *
 * It runs against whatever MONGODB_URI / SUPABASE_* your .env points at, so
 * point .env at dev and it seeds dev. It hardcodes the dev dietician
 * (tejasvini@docwellness.fit) - the seeder it delegates to defaults to the
 * prod dietician instead.
 *
 * This is a thin wrapper around scripts/seed-realistic-test-patient.js,
 * which owns the actual signup / first-consultation / payment logic and
 * stays in sync with the real consultation form. This wrapper only:
 *   - supplies the dev dietician + --execute so nothing has to be typed
 *   - forces the public-DNS fallback the seeder's raw mongoose.connect
 *     needs on machines with flaky SRV resolution (same fix as
 *     scripts/createPatientLogin.js and config/database.js's connectDB)
 *
 * The seeder prints the new patient's login email + password and its
 * patientId. Clean up later with:
 *   node scripts/seed-realistic-test-patient.js --execute --delete-email=<email>
 */

// Must run before the seeder's mongoose.connect(). Node's default DNS
// resolver refuses the "mongodb+srv://" SRV lookup on some machines (VPN /
// Docker / virtual adapters) even when the OS resolver and other running
// Node processes succeed - config/database.js's connectDB and
// scripts/createPatientLogin.js both fix it exactly this way.
require('dns').setServers(['8.8.8.8', '1.1.1.1']);

const path = require('path');

const DEV_DIETICIAN_EMAIL = 'tejasvini@docwellness.fit';

// Pass through anything the seeder understands (e.g. --gender=Male,
// --approve-payment); everything else it just ignores.
const passthrough = process.argv.slice(2);

process.argv = [
  process.argv[0],
  path.join(__dirname, 'seed-realistic-test-patient.js'),
  '--execute',
  `--dietician-email=${DEV_DIETICIAN_EMAIL}`,
  ...passthrough,
];

// Runs on require (the seeder calls its own main() at module load).
require('./seed-realistic-test-patient.js');
