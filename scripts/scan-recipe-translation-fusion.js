require('dns').setServers(['8.8.8.8', '1.1.1.1']);
require('dotenv').config({ quiet: true });
const mongoose = require('mongoose');

const LANGS = ['Hindi', 'Marathi'];

// Fused-script corruption: a Devanagari character directly touching 2+
// Latin letters with no space between them (e.g. "चikki", "काsome").
const FUSED_RE = /[ऀ-ॿ][A-Za-z]{2,}|[A-Za-z]{2,}[ऀ-ॿ]/g;

function scanField(path, text, hits) {
  if (!text) return;
  const m = text.match(FUSED_RE);
  if (m) hits.push(`${path}: fused-script "${m.join('", "')}" in: ${text}`);
}

function scanTranslation(t, lang, recipeName) {
  const hits = [];
  if (!t) return hits;
  scanField(`${lang}.name`, t.name, hits);
  scanField(`${lang}.description`, t.description, hits);
  (t.ingredients || []).forEach((ing, i) => {
    scanField(`${lang}.ingredients[${i}].name`, ing.name, hits);
    scanField(`${lang}.ingredients[${i}].description`, ing.description, hits);
  });
  (t.cookingSteps || []).forEach((s, i) => scanField(`${lang}.cookingSteps[${i}]`, s, hits));
  (t.warnings || []).forEach((s, i) => scanField(`${lang}.warnings[${i}]`, s, hits));
  return hits;
}

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  const Recipe = require('../models/Recipe');
  const recipes = await Recipe.find({}).select('name translations').lean();

  let total = 0;
  for (const r of recipes) {
    let hits = [];
    for (const lang of LANGS) {
      hits = hits.concat(scanTranslation((r.translations || {})[lang], lang, r.name));
    }
    if (hits.length) {
      total++;
      console.log(`\n=== ${r.name} [${r._id}] ===`);
      hits.forEach((h) => console.log('  ' + h));
    }
  }
  console.log(`\nTotal recipes with fused-script corruption: ${total} / ${recipes.length}`);
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
