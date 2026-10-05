/**
 * Jev plausibility pass (tasks.md 4.5) over the 155 "bulk"-provenance
 * entries in fooditem-micronutrients.json (see scripts/data/.bulk-entries-
 * need-reresearch.md for why those entries need this check at all - they
 * were recalled, not researched).
 *
 * Uses the RECALIBRATED threshold from scripts/data/.jev-plausibility-
 * calibration-notes.md: this check is poorly suited to AFFIRMING a correct
 * precise value (even canonical textbook figures scored well under the
 * project's usual 0.7 bar), but reliably flags real order-of-magnitude
 * absurdities. So here, only a score below REAL_FLAG_THRESHOLD is treated
 * as a genuine red flag worth a note; everything else is left alone.
 *
 * Output: scripts/data/bulk-plausibility-results.json
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { askJev } = require('../utils/jevClient');

const DATA_PATH = path.join(__dirname, 'data', 'fooditem-micronutrients.json');
const OUT_PATH = path.join(__dirname, 'data', 'bulk-plausibility-results.json');
const BATCH_SIZE = 12; // ~9 fields * 12 = up to 108 questions/call
const REAL_FLAG_THRESHOLD = 0.08; // per the calibration notes, not the general 0.7 bar

const UNITS = {
  saturatedFat: 'g', transFat: 'g', sugar: 'g',
  cholesterol: 'mg', sodium: 'mg', calcium: 'mg', iron: 'mg', potassium: 'mg', vitaminC: 'mg',
};

function main() {
  const data = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
  const bulkNames = Object.keys(data).filter((k) => k !== '_meta' && data[k].provenance && '_bulk' in data[k].provenance);
  console.log(`Bulk entries to plausibility-check: ${bulkNames.length}`);

  const items = [];
  for (const name of bulkNames) {
    const entry = data[name];
    const fields = Object.keys(UNITS).filter((f) => entry[f] !== null && entry[f] !== undefined);
    items.push({ name, fields });
  }

  return run(items, data);
}

async function run(items, data) {
  const results = {};
  let totalCalls = 0;
  let totalCost = 0;

  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const batch = items.slice(i, i + BATCH_SIZE);
    const state = batch.map((b) => ({ name: b.name, values: Object.fromEntries(b.fields.map((f) => [f, `${data[b.name][f]}${UNITS[f]}`])) }));
    const questions = {};
    batch.forEach((b, bi) => {
      b.fields.forEach((f) => {
        questions[`q${bi}_${f}`] = {
          type: 'noul',
          instructions: `Is \`${data[b.name][f]}${UNITS[f]}\` of ${f} per 100g of \`state[${bi}].name\` a plausible value (not an order-of-magnitude error, unit mixup, or physically impossible figure)?`,
        };
      });
    });

    console.log(`Batch ${i / BATCH_SIZE + 1}: ${batch.map((b) => b.name).join(', ')}`);
    const res = await askJev({ state, questions });
    totalCalls++;
    totalCost += (res.usage?.input_tokens ?? 0) * (42 / 1_000_000_000);

    batch.forEach((b, bi) => {
      results[b.name] = {};
      b.fields.forEach((f) => {
        const ans = res.answers[`q${bi}_${f}`];
        results[b.name][f] = { value: data[b.name][f], noul: ans?.noul ?? null };
      });
    });
  }

  const realFlags = [];
  for (const [name, fields] of Object.entries(results)) {
    for (const [field, r] of Object.entries(fields)) {
      if (r.noul !== null && r.noul < REAL_FLAG_THRESHOLD) realFlags.push({ name, field, value: r.value, noul: r.noul });
    }
  }

  fs.writeFileSync(
    OUT_PATH,
    JSON.stringify(
      {
        generatedAt: '2026-10-04',
        realFlagThreshold: REAL_FLAG_THRESHOLD,
        note: 'Threshold is the recalibrated one from .jev-plausibility-calibration-notes.md (real absurdity, not the general 0.7 bar) - this check cannot affirm correctness, only catch gross errors.',
        totalCalls,
        estimatedCostUsd: totalCost,
        realFlags,
        allResults: results,
      },
      null,
      2
    )
  );

  console.log(`\nDone. ${totalCalls} Jev calls, ~$${totalCost.toFixed(6)}.`);
  console.log(`Real red flags (score < ${REAL_FLAG_THRESHOLD}): ${realFlags.length}`);
  if (realFlags.length) console.log(JSON.stringify(realFlags, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
