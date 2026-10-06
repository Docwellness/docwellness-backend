/**
 * Scores a filled category review sheet. Offline: needs no database and no Laya.
 *
 *   node scripts/laya-category-review-import.js --sheet=<filled sheet.csv> --key=<key.csv>
 *
 * Counts, over the reviewed rows, whether the STORED category or LAYA's pick was
 * the better one (or both fine / neither / unsure), with a 95% interval, and a
 * breakdown by stored category. Rows with a bad value or no reviewer name are
 * listed as problems, never silently dropped. Rows left empty are "pending".
 */
const fs = require('fs');
const path = require('path');
const { scoreReview } = require('../utils/layaCategoryReview');

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)=(.*)$/);
    return m ? [m[1], m[2]] : [a.replace(/^--/, ''), true];
  })
);
if (!args.sheet || !args.key) {
  console.error('Usage: node scripts/laya-category-review-import.js --sheet=<filled sheet.csv> --key=<key.csv>');
  process.exit(1);
}
const r = scoreReview(fs.readFileSync(path.resolve(args.sheet), 'utf8'), fs.readFileSync(path.resolve(args.key), 'utf8'));
const pct = (n, d) => (d ? `${Math.round((100 * n) / d)}%` : 'n/a');

console.log(`Reviewed ${r.reviewed}; ${r.pending} still pending; ${r.problems.length} problem row(s).`);
for (const p of r.problems) console.log(`  problem: ${p}`);
console.log('\nWho was right where Laya and the stored category disagreed (blind A/B):');
console.log(`  stored category better: ${r.stored}  (${pct(r.stored, r.reviewed)})`);
console.log(`  Laya's pick better:     ${r.laya}  (${pct(r.laya, r.reviewed)})`);
console.log(`  both acceptable:        ${r.both}  (${pct(r.both, r.reviewed)})`);
console.log(`  neither:                ${r.neither}  (${pct(r.neither, r.reviewed)})`);
console.log(`  unsure:                 ${r.unsure}  (${pct(r.unsure, r.reviewed)})`);
if (r.layaShareOfDecided != null) {
  console.log(
    `\nWhen one was clearly better, Laya's was in ${pct(r.laya, r.stored + r.laya)} of ${r.stored + r.laya} cases ` +
      `(95% interval ${Math.round(r.layaShareInterval[0] * 100)}%-${Math.round(r.layaShareInterval[1] * 100)}%).`
  );
  console.log(`Laya's pick acceptable (better or both): ${r.layaAcceptable} of ${r.reviewed}; stored acceptable: ${r.storedAcceptable} of ${r.reviewed}.`);
}
console.log('\nBy stored category (stored / laya / both / neither / unsure):');
for (const [cat, b] of Object.entries(r.byStored)) console.log(`  ${cat.padEnd(20)} ${b.stored} / ${b.laya} / ${b.both} / ${b.neither} / ${b.unsure}`);
if (r.corrections.length) console.log(`\n${r.corrections.length} row(s) where neither was right and the reviewer named the correct category.`);
console.log('\nRead it as: a sample of the disagreements only (agreements are not reviewed), so it says whether Laya disagreements');
console.log('are mistakes or catches of wrong labels, not what Laya\'s overall accuracy is.');
