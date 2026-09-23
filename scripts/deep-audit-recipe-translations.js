/**
 * Deeper, read-only audit of Hindi/Marathi translation QUALITY across the
 * Recipe catalog - goes beyond audit-recipe-translations.js's presence
 * check (name + >=1 cooking step) to actually compare translated content
 * against the English baseline and flag likely-incomplete or low-quality
 * entries: ingredient-count mismatches, step-count mismatches, an
 * untranslated (English-copied) name, or stray English words leaking into
 * Devanagari text beyond the allowed quantity/unit exceptions.
 *
 * Usage: node scripts/deep-audit-recipe-translations.js [--json]
 */
require('dns').setServers(['8.8.8.8', '1.1.1.1']);
require('dotenv').config({ quiet: true });
const mongoose = require('mongoose');

const AS_JSON = process.argv.includes('--json');
const LANGS = ['Hindi', 'Marathi'];

// Allowed Latin tokens inside otherwise-Devanagari text: units, common
// abbreviations, and anything that's purely numeric/punctuation.
const ALLOWED_LATIN = new Set([
  'g', 'kg', 'mg', 'ml', 'l', 'tsp', 'tbsp', 'cm', 'mm', 'c', 'f',
  'min', 'mins', 'hr', 'hrs', 'sec', 'secs', 'no', 'nos', 'pc', 'pcs',
  'x',
]);

function latinLeakage(text) {
  if (!text) return [];
  const words = text.match(/[A-Za-z]+/g) || [];
  return words.filter((w) => w.length >= 2 && !ALLOWED_LATIN.has(w.toLowerCase()));
}

function hasDevanagari(text) {
  return /[ऀ-ॿ]/.test(text || '');
}

function auditOne(recipe, lang) {
  const t = (recipe.translations || {})[lang];
  const issues = [];

  if (!t) {
    issues.push('missing entirely');
    return issues;
  }

  const name = (t.name || '').trim();
  if (!name) issues.push('empty name');
  else if (name === (recipe.name || '').trim()) issues.push('name identical to English (untranslated)');
  else if (!hasDevanagari(name)) issues.push('name has no Devanagari script');
  const nameLeak = latinLeakage(name);
  if (nameLeak.length) issues.push(`English leakage in name: ${nameLeak.join(', ')}`);

  const engIngredients = recipe.ingredients || [];
  const tIngredients = t.ingredients || [];
  if (tIngredients.length !== engIngredients.length) {
    issues.push(`ingredient count mismatch (English ${engIngredients.length} vs ${lang} ${tIngredients.length})`);
  }
  tIngredients.forEach((ing, i) => {
    const iname = (ing.name || '').trim();
    if (!iname) issues.push(`ingredient[${i}] empty name`);
    else if (!hasDevanagari(iname)) issues.push(`ingredient[${i}] "${iname}" has no Devanagari`);
    const leak = latinLeakage(iname);
    if (leak.length) issues.push(`ingredient[${i}] English leakage: ${leak.join(', ')}`);
  });

  const engSteps = recipe.instructions || [];
  const tSteps = (t.cookingSteps || []).filter((s) => (s || '').trim());
  if (engSteps.length && tSteps.length === 0) {
    issues.push('no cooking steps at all');
  } else if (tSteps.length < engSteps.length) {
    issues.push(`fewer cooking steps than English (English ${engSteps.length} vs ${lang} ${tSteps.length})`);
  }
  tSteps.forEach((step, i) => {
    if (!hasDevanagari(step)) issues.push(`step[${i}] has no Devanagari at all`);
    const leak = latinLeakage(step);
    if (leak.length) issues.push(`step[${i}] English leakage: ${leak.join(', ')}`);
  });

  return issues;
}

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  const Recipe = require('../models/Recipe');

  const recipes = await Recipe.find({})
    .select('name category servingTime status translations ingredients instructions')
    .lean();

  const results = recipes.map((r) => {
    const perLang = {};
    for (const lang of LANGS) {
      const issues = auditOne(r, lang);
      if (issues.length) perLang[lang] = issues;
    }
    return { r, perLang };
  });

  const flagged = results.filter((x) => Object.keys(x.perLang).length > 0);

  if (AS_JSON) {
    console.log(
      JSON.stringify(
        flagged.map((x) => ({
          id: String(x.r._id),
          name: x.r.name,
          category: x.r.category,
          servingTime: x.r.servingTime,
          issues: x.perLang,
        })),
        null,
        2
      )
    );
    await mongoose.disconnect();
    return;
  }

  console.log(`DB: ${mongoose.connection.host} / ${mongoose.connection.name}`);
  console.log(`Total recipes: ${recipes.length}`);
  console.log(`Recipes with at least one quality issue: ${flagged.length}\n`);

  flagged
    .sort((a, b) => a.r.name.localeCompare(b.r.name))
    .forEach((x) => {
      console.log(`- ${x.r.name}  (${x.r.category} / ${x.r.servingTime})  [${x.r._id}]`);
      for (const lang of LANGS) {
        if (x.perLang[lang]) {
          x.perLang[lang].forEach((issue) => console.log(`    ${lang}: ${issue}`));
        }
      }
    });

  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
