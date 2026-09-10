/**
 * Read-only audit of Hindi/Marathi translation coverage across the Recipe
 * catalog. Reports which recipes are missing a `translations.Hindi` and/or
 * `translations.Marathi` entry (or have an empty/placeholder one), grouped
 * by category, so a translation pass can be scoped.
 *
 * Usage:  node scripts/audit-recipe-translations.js [--json]
 *   --json  dump the full missing list as JSON to stdout (for tooling)
 */

require('dns').setServers(['8.8.8.8', '1.1.1.1']);
require('dotenv').config({ quiet: true });
const mongoose = require('mongoose');

const AS_JSON = process.argv.includes('--json');
const LANGS = ['Hindi', 'Marathi'];

/** A translation counts as "present" only if it has a name AND at least one cooking step. */
function hasUsableTranslation(t) {
  if (!t) return false;
  const name = (t.name || '').trim();
  const steps = Array.isArray(t.cookingSteps) ? t.cookingSteps.filter((s) => (s || '').trim()) : [];
  return Boolean(name) && steps.length > 0;
}

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  const Recipe = require('../models/Recipe');

  const recipes = await Recipe.find({})
    .select('name category servingTime status translations language description instructions ingredients components')
    .lean();

  const rows = recipes.map((r) => {
    const t = r.translations || {};
    const missing = LANGS.filter((l) => !hasUsableTranslation(t[l]));
    return { r, missing };
  });

  const missingRows = rows.filter((x) => x.missing.length > 0);

  if (AS_JSON) {
    console.log(
      JSON.stringify(
        missingRows.map((x) => ({
          id: String(x.r._id),
          name: x.r.name,
          category: x.r.category,
          servingTime: x.r.servingTime,
          status: x.r.status,
          missing: x.missing,
        })),
        null,
        2
      )
    );
    await mongoose.disconnect();
    return;
  }

  const total = recipes.length;
  const active = recipes.filter((r) => r.status !== 'Archived').length;
  const missHi = rows.filter((x) => x.missing.includes('Hindi')).length;
  const missMr = rows.filter((x) => x.missing.includes('Marathi')).length;
  const missBothLangs = rows.filter((x) => x.missing.length === 2).length;

  console.log(`DB: ${mongoose.connection.host} / ${mongoose.connection.name}`);
  console.log(`Total recipes: ${total}  (Active: ${active}, Archived: ${total - active})`);
  console.log(`Fully translated (Hi + Mr): ${total - missingRows.length}`);
  console.log(`Missing Hindi:   ${missHi}`);
  console.log(`Missing Marathi: ${missMr}`);
  console.log(`Missing both:    ${missBothLangs}`);
  console.log(`Missing at least one: ${missingRows.length}`);

  const byCat = {};
  const byStatus = {};
  missingRows.forEach((x) => {
    byCat[x.r.category] = (byCat[x.r.category] || 0) + 1;
    byStatus[x.r.status || 'Active'] = (byStatus[x.r.status || 'Active'] || 0) + 1;
  });
  console.log('\nMissing-either, by category:');
  Object.entries(byCat)
    .sort((a, b) => b[1] - a[1])
    .forEach(([k, v]) => console.log(`  ${k.padEnd(20)} ${v}`));
  console.log('\nMissing-either, by status:', byStatus);

  console.log('\nAll recipes missing a translation:');
  missingRows
    .sort((a, b) => a.r.category.localeCompare(b.r.category) || a.r.name.localeCompare(b.r.name))
    .forEach((x) =>
      console.log(
        `  [${x.missing.join('+').padEnd(13)}] ${x.r.name}  (${x.r.category} / ${x.r.servingTime} / ${x.r.status})`
      )
    );

  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
