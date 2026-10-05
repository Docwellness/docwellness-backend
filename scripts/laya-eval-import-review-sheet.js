/**
 * Turns a dietician-filled review sheet (CSV from
 * scripts/laya-eval-export-review-sheet.js --format=csv) into evaluation data
 * in tests/laya/recipe_classification.json. Needs no database and no Laya, so
 * run it on a laptop, then commit the result.
 *
 * Strict by design: rows with a reviewer name and valid expected values become
 * examples; rows with no reviewer stay pending (skipped); any row that is
 * half-filled or has an invalid value is reported and NOTHING is written.
 *
 * Usage:
 *   node scripts/laya-eval-import-review-sheet.js --in=<sheet.csv>
 *        [--out=tests/laya/recipe_classification.json] [--replace]
 *
 * By default new examples are merged into the existing dataset file by id
 * (a re-reviewed row replaces its earlier version). --replace discards the
 * existing file first.
 */
const fs = require('fs');
const path = require('path');
const { parseCsvObjects, csvToDataset } = require('../utils/layaCsv');

function parseArgs(argv) {
  const out = {};
  for (const a of argv.slice(2)) {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    if (m) out[m[1]] = m[2] === undefined ? true : m[2];
  }
  return out;
}

const args = parseArgs(process.argv);
if (!args.in || args.in === true) {
  console.error('Usage: node scripts/laya-eval-import-review-sheet.js --in=<sheet.csv> [--out=<dataset.json>] [--replace]');
  process.exit(1);
}

const outFile = path.resolve(args.out || path.join(__dirname, '..', 'tests', 'laya', 'recipe_classification.json'));
const text = fs.readFileSync(path.resolve(args.in), 'utf8');

let objects;
try {
  objects = parseCsvObjects(text);
} catch (err) {
  console.error(`Could not read the CSV: ${err.message}`);
  process.exit(1);
}

const { examples, errors, pending } = csvToDataset(objects);

if (errors.length) {
  console.error(`${errors.length} problem(s) found. Nothing was written. Fix these rows and run again:`);
  for (const e of errors) console.error(`  line ${e.line === null ? '?' : e.line} (id ${e.id || '-'}): ${e.message}`);
  process.exit(1);
}

let existing = [];
if (!args.replace && fs.existsSync(outFile)) existing = JSON.parse(fs.readFileSync(outFile, 'utf8'));
const byId = new Map(existing.map((e) => [e.id, e]));
for (const e of examples) byId.set(e.id, e);
const merged = [...byId.values()];

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, `${JSON.stringify(merged, null, 2)}\n`);

const perMeal = {};
for (const e of merged) {
  const m = (e.expected && e.expected.meal_type) || '(protein only)';
  perMeal[m] = (perMeal[m] || 0) + 1;
}
console.log(`Imported ${examples.length} reviewed row(s); ${pending} still pending (no reviewer) were skipped.`);
console.log(`Dataset now has ${merged.length} example(s) in ${outFile}`);
console.log('Per expected meal type:', perMeal);
console.log('Commit this file; it ships in the backend image so scripts/laya-eval-run.js can read it.');
