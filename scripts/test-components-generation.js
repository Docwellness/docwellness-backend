/**
 * One-off manual test: confirms generateRecipeWithAI now returns real
 * per-item `components` (e.g. "3 nos" idli, "1 bowl" sambar) instead of a
 * single forced gram total - see the COMPONENTS RULE in openaiClient.js's
 * prompt. Not wired into any test runner - just run directly.
 *
 * Usage (point MONGODB_URI at a reachable cluster first if your local
 * .env still defaults to localhost):
 *   node scripts/test-components-generation.js
 */

require('dotenv').config();
const mongoose = require('mongoose');

// Node's own DNS resolver can fail on the SRV-record lookup a
// "mongodb+srv://" URI needs (querySrv ECONNREFUSED) even when other tools
// on the same machine (e.g. mongosh) resolve it fine - typically because
// Node is picking up a local/VPN DNS server that doesn't handle SRV
// records, while other tools fall back differently. Pointing Node's
// resolver at public DNS sidesteps that without needing any OS/network
// config change.
require('dns').setServers(['8.8.8.8', '1.1.1.1']);

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  const { generateRecipeWithAI } = require('../utils/openaiClient');

  const r = await generateRecipeWithAI({
    name: 'Idli with Sambar and Chutney',
    servingTime: 'Breakfast',
    servings: 1,
    dietaryHabits: { vegetarian: true },
    freeFrom: {},
    languages: ['English'],
  });

  console.log('name:', r.name);
  console.log('components:', JSON.stringify(r.components, null, 2));
  console.log('servingSize (legacy mirror):', JSON.stringify(r.servingSize, null, 2));
  console.log('secondaryComponent (legacy mirror):', JSON.stringify(r.secondaryComponent, null, 2));

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
