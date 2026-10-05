/**
 * Builds a REVIEW SHEET for the Laya evaluation dataset from real, already-
 * saved recipes - so dieticians label real data instead of starting from a
 * blank page. Read-only; makes no database writes.
 *
 * This does NOT create evaluation data. Every row it writes has
 * `expected: null` and `reviewed_by: null`, and scripts/laya-eval-run.js
 * ignores rows in that state. A row only counts once a dietician records the
 * serving slots it suits and a reviewer name (see tests/laya/README.md).
 *
 * What the reviewer records is EVERY serving slot the recipe suits (Morning
 * Drink, Breakfast, Brunch, Lunch, Evening Snack, Dinner, Night Drink): a
 * recipe can suit several, and drinks and meals are different things. Recipes
 * are sampled from all seven slots, stratified.
 *
 * Deliberately excludes Laya's own prediction from the sheet, so a reviewer
 * isn't anchored by what the model said. The CSV is also BLIND by default: it
 * does not show the recipe's existing servingTime, so the reviewer judges from
 * the recipe alone, and the rows are shuffled (the sample is grouped by slot,
 * and the order would reveal it). --with-source adds the existing slot (not
 * blind). The existing slot stays in the JSON sheet under `source`, outside
 * `input`.
 *
 * Usage:
 *   node scripts/laya-eval-export-review-sheet.js [--per-class=15] [--seed=1]
 *        [--format=json|csv] [--stdout] [--with-source] [--slot-columns]
 *        [--out=<file>]
 *
 * --format=csv gives a spreadsheet for the reviewer (read back with
 * scripts/laya-eval-import-review-sheet.js). --stdout prints the sheet instead
 * of writing a file, with every log line sent to stderr so stdout is clean:
 * the backend container's disk is ephemeral, so on production run
 *   node scripts/laya-eval-export-review-sheet.js --format=csv --stdout
 * in the Coolify Terminal and copy the output into a .csv file.
 * --slot-columns replaces the single `suitable_slots` column with seven y/n
 * columns, one per slot, when every slot must be explicitly judged.
 *
 * Supplements (tablets) are not sampled. Sides (chutney, raita, papad) and teas
 * ARE, so reviewers must be told how to treat them (tests/laya/README.md).
 */
// quiet: dotenv's own banner goes to stdout and would corrupt --stdout output.
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const connectDB = require('../config/database');
const Recipe = require('../models/Recipe');
const { sampleStratified, shuffleSeeded } = require('../utils/layaEval');
const { SLOT_NAMES, slotKeyFromServingTime } = require('../utils/layaSlots');
const { toCsv, sheetToCsvRows, csvColumns } = require('../utils/layaCsv');

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
  const perClass = Number(args['per-class']) || 15;
  const seed = Number(args.seed) || 1;
  const format = String(args.format || 'json').toLowerCase();
  if (!['json', 'csv'].includes(format)) {
    console.error('--format must be json or csv');
    process.exit(1);
  }
  const toStdout = Boolean(args.stdout);
  // In stdout mode the sheet owns stdout: everything else (including
  // connectDB's own console.log) goes to stderr.
  if (toStdout) console.log = (...a) => console.error(...a);
  const outFile = path.resolve(
    args.out || path.join(__dirname, '..', 'tests', 'laya', 'pending', `recipe_classification.pending.${format}`)
  );

  await connectDB();
  // Supplements (tablets) are not meals, so a slot label is meaningless for them.
  const recipes = await Recipe.find({
    servingTime: { $in: SLOT_NAMES },
    category: { $ne: 'Supplements' },
  })
    .select('name cuisine category servingTime ingredients.name')
    .lean();

  // Shuffled after sampling: the sample is grouped by slot, and for a blind
  // review the row order must not reveal it.
  const sample = shuffleSeeded(
    sampleStratified(recipes, (r) => slotKeyFromServingTime(r.servingTime), perClass, seed),
    seed + 1
  );

  const counts = {};
  const sheet = sample.map((r) => {
    const sourceSlot = slotKeyFromServingTime(r.servingTime);
    counts[r.servingTime] = (counts[r.servingTime] || 0) + 1;
    return {
      id: String(r._id),
      // `input` is what Laya will be shown, so it carries NO servingTime: the
      // slot would leak the answer to the slot questions.
      input: {
        recipe: {
          name: r.name,
          cuisine: r.cuisine || null,
          category: r.category || null,
          ingredients: (r.ingredients || []).map((i) => ({ name: i.name })),
        },
      },
      // The recipe's existing slot, kept OUTSIDE `input` for later analysis. It is
      // hidden from reviewers unless --with-source is passed (blind review).
      source: { servingTime: r.servingTime, slot: sourceSlot },
      // The reviewer records these (CSV: suitable_slots, expected_protein_level).
      expected: null,
      reviewed_by: null,
    };
  });

  const withSource = Boolean(args['with-source']);
  const slotColumns = Boolean(args['slot-columns']);
  const content =
    format === 'csv'
      ? toCsv(sheetToCsvRows(sheet, { withSource }), csvColumns({ withSource, slotColumns }))
      : JSON.stringify(sheet, null, 2);
  if (toStdout) {
    process.stdout.write(content);
    console.log(`Printed ${sheet.length} unreviewed rows (${format}${format === 'csv' && !withSource ? ', blind' : ''}) to stdout.`);
  } else {
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, content);
    console.log(`Wrote ${sheet.length} unreviewed rows to ${outFile}`);
  }
  console.log('Per existing slot:', counts, `(requested up to ${perClass} each, seed ${seed})`);
  console.log('Nothing here is evaluation data until a dietician records the suitable slots and a reviewer name.');
  await mongoose.disconnect();
})().catch((err) => {
  console.error('export failed:', err.message);
  process.exit(1);
});
