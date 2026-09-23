/**
 * Hand-authored fixes for corrupted / incomplete Hindi + Marathi recipe
 * translations, found via:
 *   - scripts/deep-audit-recipe-translations.js  (count parity, English leakage)
 *   - scripts/scan-recipe-translation-fusion.js  (fused Latin+Devanagari, e.g. "चikki")
 *
 * Meant to be run directly in the production environment (e.g. a Coolify
 * terminal into the docwellness-backend container), where MONGODB_URI is
 * already the real prod connection string - no DNS override, no .env
 * needed (uses whatever MONGODB_URI is already in the environment).
 *
 * Bug classes fixed:
 *   - fused-script corruption ("क्रीमiness", "चikki", "पापrika", "चopped", "एकsavory", "गourd")
 *   - stray English words / English glosses ("chopped", "scrambled", "(cumin)", "(Foxnuts)", ...)
 *   - Marathi ingredient entries dropped from the list (count parity with English)
 *   - a translated cooking step missing vs English `instructions[]` (always the
 *     prepended safety note at EN[0] - "serve curd on the side" / "let it cool
 *     before adding honey"), inserted at index 0 in both languages
 *   - a few clear mistranslations found while fixing the above in the same
 *     recipes (Marathi "मूळ डाळ" for moong dal, honey rendered as "गूळ"/"हनी",
 *     bell pepper labelled "हिरवी मिरची", gibberish "कडूनट").
 *
 * Only the named recipes / languages are touched; English content never is.
 * Each op is idempotent: replaceAll is a no-op once the text is gone, insert
 * only fires while the translated array is still shorter than English. Safe
 * to run more than once.
 *
 * Writes use `$set: { 'translations.<Lang>': <whole corrected subdoc> }` so
 * sibling fields (components, warnings, ...) are carried over unchanged.
 *
 * Usage (run from the directory containing this repo's models/ folder, i.e.
 * this file must sit at <repo-root>/scripts/apply-recipe-translation-fixes-prod.js):
 *   node scripts/apply-recipe-translation-fixes-prod.js               # dry run (prints diffs, writes nothing)
 *   node scripts/apply-recipe-translation-fixes-prod.js --execute     # write
 *   node scripts/apply-recipe-translation-fixes-prod.js --only="Peanut Chikki" [--execute]   # one recipe
 *
 * ALWAYS run without --execute first and read the diffs before adding --execute.
 */
require('dotenv').config({ quiet: true });
const mongoose = require('mongoose');

const EXECUTE = process.argv.includes('--execute');
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) || '').slice('--only='.length) || null;

// ---- Hand-authored fix spec -------------------------------------------------
// op types:
//   { lang, replaceAll: [find, replace] }              - every string field in that language
//   { lang, set: 'ingredients.13.description', value } - one field
//   { lang, insert: 'ingredients'|'cookingSteps', index, value }
const HONEY_STEP_TEA = {
  Hindi: 'उबालने के बाद चाय को थोड़ा ठंडा होने दें, फिर शहद मिलाएं - गरम चाय में शहद न डालें।',
  Marathi: 'उकळल्यानंतर चहा थोडा थंड होऊ द्या आणि मगच मध मिसळा - गरम चहात मध घालू नका.',
};
const HONEY_STEP_MILK = {
  Hindi: 'गरम करने के बाद दूध को थोड़ा ठंडा होने दें, फिर शहद मिलाएं - गरम दूध में शहद न डालें।',
  Marathi: 'गरम केल्यानंतर दूध थोडे थंड होऊ द्या आणि मगच मध मिसळा - गरम दुधात मध घालू नका.',
};
const CURD_STEP = {
  Hindi: 'दही को एक छोटी कटोरी में अलग से परोसें - इसे बैटर में न मिलाएं और न ही गरम करें।',
  Marathi: 'दही एका लहान वाटीत बाजूला सर्व्ह करा - ते बॅटरमध्ये मिसळू नका किंवा गरम करू नका.',
};

const FIXES = {
  'Chickpeas Salad': [
    { lang: 'Hindi', replaceAll: ['क्रीमiness', 'क्रीमीपन'] },
  ],
  'Banana Oats Pancakes': [
    { lang: 'Hindi', replaceAll: ['क्रीमiness', 'क्रीमीपन'] },
  ],
  'Peanut Chikki with Bananas': [
    { lang: 'Hindi', replaceAll: ['चikki', 'चिक्की'] },
    { lang: 'Marathi', replaceAll: ['चikki', 'चिक्की'] },
    // "चक्की" means a grinding mill - make the Marathi spelling consistent.
    { lang: 'Marathi', replaceAll: ['चक्की', 'चिक्की'] },
  ],
  'Peanut Chikki': [
    { lang: 'Hindi', replaceAll: ['चikki', 'चिक्की'] },
    { lang: 'Marathi', replaceAll: ['चikki', 'चिक्की'] },
  ],
  'Grilled Marinated Chicken Leg': [
    { lang: 'Hindi', replaceAll: ['पापrika', 'पैप्रिका'] },
  ],
  'Doodhi Chilla': [
    { lang: 'Hindi', set: 'ingredients.1.name', value: 'दूधी' },
    { lang: 'Marathi', set: 'ingredients.1.name', value: 'दूधी' },
    { lang: 'Hindi', insert: 'cookingSteps', index: 0, value: CURD_STEP.Hindi },
    { lang: 'Marathi', insert: 'cookingSteps', index: 0, value: CURD_STEP.Marathi },
  ],
  'Carrot Besan Chilla': [
    { lang: 'Hindi', replaceAll: ['एकsavory', 'एक नमकीन'] },
    { lang: 'Hindi', insert: 'cookingSteps', index: 0, value: CURD_STEP.Hindi },
    { lang: 'Marathi', insert: 'cookingSteps', index: 0, value: CURD_STEP.Marathi },
  ],
  'Moong Dal Chilla': [
    { lang: 'Hindi', insert: 'cookingSteps', index: 0, value: CURD_STEP.Hindi },
    {
      lang: 'Marathi',
      insert: 'cookingSteps',
      index: 0,
      value: 'दही एका लहान वाटीत बाजूला सर्व्ह करा - ते पेस्टमध्ये मिसळू नका किंवा गरम करू नका.',
    },
    { lang: 'Marathi', replaceAll: ['मूळ डाळ', 'मूग डाळ'] },
    { lang: 'Marathi', replaceAll: ['एक कडूनट पेस्ट', 'एक पळीभर पेस्ट'] },
  ],
  'Matki Usal': [
    { lang: 'Hindi', replaceAll: ['chopped प्याज', 'कटा हुआ प्याज'] },
    { lang: 'Hindi', replaceAll: ['चopped टमाटर', 'कटे हुए टमाटर'] },
  ],
  Varan: [
    { lang: 'Hindi', replaceAll: ['chopped प्याज', 'कटा हुआ प्याज'] },
    { lang: 'Hindi', replaceAll: ['chopped टमाटर', 'कटे हुए टमाटर'] },
    // ingredients[13] = Low-Fat Curd, used in the koshimbir served alongside.
    { lang: 'Hindi', set: 'ingredients.13.description', value: 'कोशिंबीर में क्रीमीपन और प्रोबायोटिक्स प्रदान करता है।' },
  ],
  'Veg Usal': [
    { lang: 'Hindi', replaceAll: ['chopped प्याज', 'कटा हुआ प्याज'] },
    { lang: 'Hindi', replaceAll: ['चopped टमाटर', 'कटे हुए टमाटर'] },
  ],
  'Matar Paratha': [
    { lang: 'Hindi', replaceAll: ['chopped प्याज', 'कटा हुआ प्याज'] },
    { lang: 'Hindi', replaceAll: ['chopped धनिया पत्ते', 'कटे हुए धनिया पत्ते'] },
  ],
  'Onion Uttapa': [
    { lang: 'Hindi', replaceAll: ['chopped प्याज', 'कटा हुआ प्याज'] },
  ],
  'Egg Chapati Rolls': [
    { lang: 'Hindi', replaceAll: ['ताकि scrambled हो जाए', 'ताकि अंडे की भुर्जी बन जाए'] },
  ],
  'Fennel Seed Water': [
    { lang: 'Hindi', replaceAll: ['खाली पेट infused पानी पिएं', 'खाली पेट सौंफ वाला यह पानी पिएं'] },
  ],
  'Calcium Supplement': [
    {
      lang: 'Hindi',
      replaceAll: ['ideally आयरन सप्लीमेंट से कुछ घंटे अलग', 'और हो सके तो आयरन सप्लीमेंट से कुछ घंटे के अंतर पर'],
    },
  ],
  'Roasted Makhana and Chana': [
    {
      lang: 'Hindi',
      set: 'cookingSteps.4',
      value: 'सब कुछ अच्छे से मिलाएं ताकि मसाले हर तरफ समान रूप से लग जाएं।',
    },
  ],
  'Jeera Tea': [
    { lang: 'Hindi', replaceAll: ['जीरा (cumin)', 'जीरा'] },
    { lang: 'Marathi', replaceAll: ['जीरा (cumin)', 'जीरा'] },
  ],
  'Moong Sprouts Chaat': [
    { lang: 'Marathi', replaceAll: ['मूग क sprouts', 'मूग स्प्राउट्स'] },
  ],
  'Roasted Foxnut Trail Mix': [
    { lang: 'Hindi', replaceAll: ['मखाना (Foxnuts)', 'मखाना'] },
    { lang: 'Marathi', replaceAll: ['मखाणे (Foxnuts)', 'मखाणे'] },
  ],
  'Bajra Bhakri': [
    { lang: 'Marathi', replaceAll: ['बाजरी (Pearl Millet) पीठ', 'बाजरीचे पीठ'] },
  ],
  'Ragi Idli': [
    { lang: 'Marathi', set: 'cookingSteps.5', value: 'इडलीचे साचे चांगले ग्रीस करा आणि प्रत्येक साच्यात बॅटर ओता.' },
    { lang: 'Marathi', set: 'cookingSteps.7', value: 'इडल्या साच्यांमधून काढा आणि गरमागरम सर्व्ह करा.' },
  ],
  'Besan Chilla': [
    // English ingredients[3] = Green Chilli (dropped from the Marathi list).
    {
      lang: 'Marathi',
      insert: 'ingredients',
      index: 3,
      value: { name: 'हिरवी मिरची', description: 'तिखटपणा आणि चव वाढवते.' },
    },
  ],
  'Paneer Bhurji': [
    // Marathi [3] was Bell Pepper's description under a "green chilli" label,
    // and the real Green Chilli (English [4]) was dropped.
    { lang: 'Marathi', set: 'ingredients.3.name', value: 'ढोबळी मिरची' },
    {
      lang: 'Marathi',
      insert: 'ingredients',
      index: 4,
      value: { name: 'हिरवी मिरची', description: 'तिखटपणा आणि चव वाढवते.' },
    },
    { lang: 'Marathi', replaceAll: ['चिरलेला पनीर आणि हिरवी मिरची घाला', 'कुस्करलेले पनीर आणि हिरवी ढोबळी मिरची घाला'] },
  ],
  'Moong Dal Khichdi': [
    // English ingredients[8] = Green Chilli (dropped from the Marathi list).
    {
      lang: 'Marathi',
      insert: 'ingredients',
      index: 8,
      value: { name: 'हिरवी मिरची', description: 'तिखटपणा आणि चव वाढवते.' },
    },
    { lang: 'Marathi', replaceAll: ['मूळ डाळ', 'मूग डाळ'] },
  ],
  'Fennel Tea': [
    { lang: 'Hindi', insert: 'cookingSteps', index: 0, value: HONEY_STEP_TEA.Hindi },
    { lang: 'Marathi', insert: 'cookingSteps', index: 0, value: HONEY_STEP_TEA.Marathi },
    { lang: 'Marathi', replaceAll: ['गूळ', 'मध'] }, // English is Honey, not jaggery
  ],
  'Cinnamon Tea': [
    { lang: 'Hindi', insert: 'cookingSteps', index: 0, value: HONEY_STEP_TEA.Hindi },
    { lang: 'Marathi', insert: 'cookingSteps', index: 0, value: HONEY_STEP_TEA.Marathi },
    { lang: 'Marathi', replaceAll: ['गूळ', 'मध'] },
  ],
  'Tulsi Tea': [
    { lang: 'Hindi', insert: 'cookingSteps', index: 0, value: HONEY_STEP_TEA.Hindi },
    { lang: 'Marathi', insert: 'cookingSteps', index: 0, value: HONEY_STEP_TEA.Marathi },
    { lang: 'Marathi', replaceAll: ['हनी', 'मध'] }, // transliterated English "honey"
  ],
  'Turmeric Milk': [
    { lang: 'Hindi', insert: 'cookingSteps', index: 0, value: HONEY_STEP_MILK.Hindi },
    { lang: 'Marathi', insert: 'cookingSteps', index: 0, value: HONEY_STEP_MILK.Marathi },
    { lang: 'Marathi', replaceAll: ['गूळ', 'मध'] },
  ],
  'Turmeric Milk with Dates': [
    { lang: 'Hindi', insert: 'cookingSteps', index: 0, value: HONEY_STEP_MILK.Hindi },
    { lang: 'Marathi', insert: 'cookingSteps', index: 0, value: HONEY_STEP_MILK.Marathi },
  ],
};

// ---- helpers ----------------------------------------------------------------
const ALLOWED_LATIN = new Set([
  'g', 'kg', 'mg', 'ml', 'l', 'tsp', 'tbsp', 'cm', 'mm', 'c', 'f',
  'min', 'mins', 'hr', 'hrs', 'sec', 'secs', 'no', 'nos', 'pc', 'pcs', 'x',
]);

/** Returns [label, getter, setter] for every translatable string in a language subdoc. */
function stringFields(t) {
  const out = [];
  for (const k of ['name', 'description']) {
    if (typeof t[k] === 'string') out.push([k, () => t[k], (v) => { t[k] = v; }]);
  }
  (t.ingredients || []).forEach((ing, i) => {
    for (const k of ['name', 'description']) {
      if (typeof ing[k] === 'string') out.push([`ingredients.${i}.${k}`, () => ing[k], (v) => { ing[k] = v; }]);
    }
  });
  (t.components || []).forEach((c, i) => {
    if (typeof c.label === 'string') out.push([`components.${i}.label`, () => c.label, (v) => { c.label = v; }]);
  });
  for (const arr of ['cookingSteps', 'warnings']) {
    (t[arr] || []).forEach((s, i) => {
      if (typeof s === 'string') out.push([`${arr}.${i}`, () => t[arr][i], (v) => { t[arr][i] = v; }]);
    });
  }
  return out;
}

function setPath(obj, path, value) {
  const parts = path.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    cur = cur[parts[i]];
    if (cur == null) throw new Error(`path ${path} does not exist`);
  }
  const last = parts[parts.length - 1];
  if (cur[last] === undefined) throw new Error(`path ${path} does not exist`);
  const before = cur[last];
  cur[last] = value;
  return before;
}

function validate(t, recipe, lang) {
  const problems = [];
  const enIng = (recipe.ingredients || []).length;
  const enSteps = (recipe.instructions || []).length;
  if ((t.ingredients || []).length !== enIng) problems.push(`ingredients ${(t.ingredients || []).length} != English ${enIng}`);
  if ((t.cookingSteps || []).length !== enSteps) problems.push(`cookingSteps ${(t.cookingSteps || []).length} != English ${enSteps}`);
  if ((t.name || '').trim().toLowerCase() === (recipe.name || '').trim().toLowerCase()) problems.push('name identical to English');
  for (const [label, get] of stringFields(t)) {
    const v = get() || '';
    const glued = v.match(/[ऀ-ॿ][A-Za-z]{2,}|[A-Za-z]{2,}[ऀ-ॿ]/g);
    if (glued) problems.push(`${label}: fused script ${glued.join(', ')}`);
    const words = (v.match(/[A-Za-z]+/g) || []).filter((w) => w.length >= 2 && !ALLOWED_LATIN.has(w.toLowerCase()));
    if (words.length) problems.push(`${label}: English words ${words.join(', ')}`);
  }
  return problems;
}

async function main() {
  console.log(EXECUTE ? '=== EXECUTING ===' : '=== DRY RUN (pass --execute to write) ===');
  console.log(`DB: ${(process.env.MONGODB_URI || '').replace(/\/\/[^@]+@/, '//<redacted>@')}`);
  await mongoose.connect(process.env.MONGODB_URI);
  const Recipe = require('../models/Recipe');

  const names = Object.keys(FIXES).filter((n) => !ONLY || n === ONLY);
  let touched = 0;
  let failed = 0;
  for (const name of names) {
    const matches = await Recipe.find({ name }).lean();
    if (matches.length !== 1) {
      console.log(`\n!! ${name}: expected 1 recipe, found ${matches.length} - skipped`);
      failed++;
      continue;
    }
    const recipe = matches[0];
    const translations = recipe.translations || {};
    const updates = {};
    const log = [];
    const errors = [];

    for (const lang of ['Hindi', 'Marathi']) {
      const ops = FIXES[name].filter((o) => o.lang === lang);
      if (!ops.length) continue;
      if (!translations[lang]) { errors.push(`${lang}: no translation present`); continue; }
      const t = JSON.parse(JSON.stringify(translations[lang]));
      let changed = false;

      for (const op of ops) {
        if (op.replaceAll) {
          const [find, repl] = op.replaceAll;
          for (const [label, get, set] of stringFields(t)) {
            const v = get();
            if (v && v.includes(find)) {
              const nv = v.split(find).join(repl);
              set(nv);
              changed = true;
              log.push(`  [${lang}] ${label}\n      - ${v}\n      + ${nv}`);
            }
          }
        } else if (op.set) {
          const before = setPath(t, op.set, op.value);
          if (before !== op.value) {
            changed = true;
            log.push(`  [${lang}] ${op.set}\n      - ${before}\n      + ${op.value}`);
          }
        } else if (op.insert) {
          const arr = t[op.insert] || (t[op.insert] = []);
          const enLen = op.insert === 'ingredients' ? recipe.ingredients.length : recipe.instructions.length;
          if (arr.length < enLen) {
            arr.splice(op.index, 0, op.value);
            changed = true;
            const shown = typeof op.value === 'string' ? op.value : `${op.value.name} | ${op.value.description}`;
            log.push(`  [${lang}] INSERT ${op.insert}[${op.index}]\n      + ${shown}`);
          }
        }
      }

      const problems = validate(t, recipe, lang);
      if (problems.length) errors.push(...problems.map((p) => `${lang}: ${p}`));
      if (changed) updates[`translations.${lang}`] = t;
    }

    console.log(`\n### ${name} (${recipe._id})`);
    log.forEach((l) => console.log(l));
    if (!log.length) console.log('  (already applied - no changes)');
    if (errors.length) {
      failed++;
      errors.forEach((e) => console.log(`  !! ${e}`));
      console.log('  -> NOT written (validation failed)');
      continue;
    }
    if (!Object.keys(updates).length) continue;
    touched++;
    if (EXECUTE) {
      const res = await Recipe.updateOne({ _id: recipe._id }, { $set: updates });
      console.log(`  -> written (matched ${res.matchedCount}, modified ${res.modifiedCount})`);
    }
  }

  console.log('\n--- summary ---');
  console.log(`Recipes ${EXECUTE ? 'updated' : 'to update'}: ${touched}`);
  console.log(`Recipes with problems: ${failed}`);
  await mongoose.disconnect();
  if (failed) process.exitCode = 1;
}

main().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect();
  process.exit(1);
});
