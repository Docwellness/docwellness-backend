/**
 * Builds a blind review sheet for the recipes where Laya's category differs
 * from the stored one, so a dietician can say who is right. Agreement with a
 * label is not accuracy; this is how we find out whether Laya's disagreements
 * are mistakes or catches of mislabelled recipes (`category` defaults to Indian).
 *
 * Read-only. Calls a real Laya one request at a time (name-only request, ~87
 * tokens, ~2 s a call), so run it at a quiet time in the backend container's
 * Coolify Terminal. Same sample as the category experiment (default 9 categories
 * x 5 recipes, seed 1; category and cuisine are never sent to Laya).
 *
 * Two files come out, and they must stay apart:
 *   SHEET: send to the dietician. Recipe, ingredients, and two options A / B in
 *          random order. It does NOT say which option is the stored category or
 *          which is Laya's.
 *   KEY:   keep. Maps each A/B to stored vs Laya. Scoring joins the two by id.
 *
 * Usage:
 *   node scripts/laya-category-review-export.js --stdout [--per-class=5] [--seed=1] [--min-class=5] [--exclude=Other]
 *   node scripts/laya-category-review-export.js [--out-dir=<dir>]
 * --stdout prints the two CSVs, each between marker lines, with all logging on
 * stderr (the container's disk is ephemeral; copy each block into a .csv file).
 * Score the filled sheet with scripts/laya-category-review-import.js.
 */
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const { sampleStratified, shuffleSeeded } = require('../utils/layaEval');
const { selectClasses, buildCategoryRequest, categoryProbabilities, askWithRetry } = require('../utils/layaCategory');
const { buildReview, sheetCsv, keyCsv } = require('../utils/layaCategoryReview');

function parseArgs(argv) {
  const out = {};
  for (const a of argv.slice(2)) {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    if (m) out[m[1]] = m[2] === undefined ? true : m[2];
  }
  return out;
}

(async () => {
  const args = parseArgs(process.argv);
  // Everything except the CSV goes to stderr so stdout can be copied cleanly.
  console.log = (...a) => console.error(...a);
  const mongoose = require('mongoose');
  const connectDB = require('../config/database');
  const config = require('../config/environment');
  const Recipe = require('../models/Recipe');
  const { askLaya } = require('../services/layaDecisionService');

  const perClass = Number(args['per-class']) || 5;
  const minClass = Number(args['min-class']) || 5;
  const seed = Number(args.seed) || 1;
  const exclude = args.exclude && args.exclude !== true ? String(args.exclude).split(',').map((s) => s.trim()) : ['Other'];
  config.laya.timeoutMs = Number(args['timeout-ms'] || 60000);
  if (!config.laya.enabled || !config.laya.baseUrl || !config.laya.apiKey) {
    console.error('LAYA_ENABLED=true plus LAYA_BASE_URL and LAYA_API_KEY must be set (run this in the backend container).');
    process.exit(1);
  }

  await connectDB();
  const docs = await Recipe.find({ category: { $exists: true, $nin: [null, ''] } }).select('name category ingredients.name').lean();
  await mongoose.disconnect();

  const recipes = docs.map((r) => ({ id: String(r._id), name: r.name, category: r.category, ingredients: (r.ingredients || []).map((i) => ({ name: i.name })) }));
  const classes = selectClasses(recipes, { minPerClass: minClass, exclude });
  const names = new Set(classes.map((c) => c.name));
  const pool = recipes.filter((r) => names.has(r.category));
  const sample = shuffleSeeded(sampleStratified(pool, (r) => r.category, perClass, seed), seed + 1);
  console.log(`Asking Laya about ${sample.length} recipes (${classes.length} categories), name only...`);

  const items = [];
  let consecutive = 0;
  for (let i = 0; i < sample.length; i += 1) {
    const rec = sample[i];
    // eslint-disable-next-line no-await-in-loop
    const r = await askWithRetry(askLaya, buildCategoryRequest(rec, classes));
    items.push({ ...rec, probs: r.ok ? categoryProbabilities(r.answers, classes) : null });
    consecutive = r.ok ? 0 : consecutive + 1;
    if (consecutive >= 5) {
      console.error(`Stopped: 5 calls in a row failed (last: ${r.reason}${r.detail ? `: ${r.detail}` : ''}). Laya looks down.`);
      process.exit(1);
    }
    if ((i + 1) % 10 === 0 || i + 1 === sample.length) console.log(`  ${i + 1}/${sample.length}`);
  }

  const { sheet, key, agreed, failed } = buildReview({ items, classes, seed });
  console.log(`Laya agreed with the stored category on ${agreed}; ${failed} calls failed; ${sheet.length} recipes go to the reviewer.`);

  if (args.stdout) {
    process.stdout.write(`----- SHEET (send to the dietician; save as category-review-sheet.csv) -----\n${sheetCsv(sheet)}`);
    process.stdout.write(`----- KEY (keep, do not send; save as category-review-key.csv) -----\n${keyCsv(key)}`);
    process.stdout.write('----- END -----\n');
    return;
  }
  const dir = path.resolve(args['out-dir'] || path.join(__dirname, '..', 'tests', 'laya', 'pending'));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'category-review-sheet.csv'), sheetCsv(sheet));
  fs.writeFileSync(path.join(dir, 'category-review-key.csv'), keyCsv(key));
  console.log(`Wrote category-review-sheet.csv and category-review-key.csv to ${dir} (ephemeral on the container: prefer --stdout there).`);
})().catch((err) => {
  console.error('laya-category-review-export failed:', err.message);
  process.exit(1);
});
