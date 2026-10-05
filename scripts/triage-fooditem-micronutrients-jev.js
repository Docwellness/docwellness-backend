/**
 * Jev triage pass for the fill-recipe-micronutrients change (design.md
 * Decision 6, tasks.md section 3). Jev makes fast, cheap classification
 * judgments only - it never produces a nutrition number. Its answers route
 * and prioritize the real research work done later by the Claude session
 * (section 4), and flag which "zero" rule (design.md Decision 5) an
 * ingredient is likely to qualify for.
 *
 * Per FoodItem (plus the 13 ingredient names referenced by recipes that
 * don't yet resolve to any FoodItem - see the "unresolved" entries), asks:
 *   - origin (choice): plant / animal_meat_fish_egg / dairy / oil_plant /
 *     fat_animal / processed_packaged / spice_blend / salt_mineral / water
 *   - cholesterol_definitionally_zero, trans_fat_possible, sodium_significant (noul)
 *   - lookup_route (choice): which food-composition source to check first
 *   - research_priority (score, 0-3): ordering hint from recipe-usage count
 *
 * Batches many FoodItems' questions into one Jev call (one shared `state`
 * array, one set of per-index questions referencing `foodItems[i]` in each
 * question's `instructions`) rather than one call per ingredient - see
 * https://docs.typesafe.ai/concepts/how-to-build-with-system-one and the
 * fan-out pattern doc.
 *
 * Only catalog data goes into `state`: ingredient names, a handful of
 * example recipe names, and a usage count. No patient/PlanItem/PHI data.
 *
 * Usage (staging only - never point MONGODB_URI at prod for this):
 *   MONGODB_URI="mongodb://localhost:27018/docwellness_staging" node scripts/triage-fooditem-micronutrients-jev.js
 *
 * Output: scripts/data/fooditem-micronutrient-triage.json
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const connectDB = require('../config/database');
const { askJev } = require('../utils/jevClient');

const OUT_PATH = path.join(__dirname, 'data', 'fooditem-micronutrient-triage.json');
const AUDIT_BASELINE_PATH = path.join(__dirname, 'data', 'recipe-micronutrient-audit-baseline-2026-09-29.json');
const BATCH_SIZE = 15; // 6 questions/item * 15 = 90 questions/call
const CONFIDENCE_BAR = 0.7; // design.md Decision 6's inherited jev-skill rule

// Ingredient names referenced by staging recipes that don't resolve to a
// FoodItem doc today, split by why (found empirically 2026-09-29 - see the
// triage run's own log): 10 have no FoodItem at all yet; Water/Curd/Ghee DO
// have a FoodItem (name matches) but still show up in the audit's
// `unresolvedIngredientNames`, which points at a resolution gap other than
// "FoodItem missing" (most likely a unit the FoodItem's `unitConversions`
// doesn't cover for that recipe's `rawQuantity` unit) - flagged here rather
// than silently treated the same as a genuinely-missing FoodItem, since
// fixing it needs a different fix (a unit conversion, not new research).
const UNRESOLVED_NAMES = [
  { name: 'Butter', resolutionGap: 'missing-fooditem' },
  { name: 'Sambar Powder', resolutionGap: 'missing-fooditem' },
  { name: 'Low-Fat Milk', resolutionGap: 'missing-fooditem' },
  { name: 'Celery', resolutionGap: 'missing-fooditem' },
  { name: 'Vegetable Broth', resolutionGap: 'missing-fooditem' },
  { name: 'Coconut Oil', resolutionGap: 'missing-fooditem' },
  { name: 'Mayonnaise', resolutionGap: 'missing-fooditem' },
  { name: 'Dijon Mustard', resolutionGap: 'missing-fooditem' },
  { name: 'Baking Soda', resolutionGap: 'missing-fooditem' },
  { name: 'Asafoetida', resolutionGap: 'missing-fooditem' },
  { name: 'Water', resolutionGap: 'existing-fooditem-unit-conversion-gap' },
  { name: 'Curd', resolutionGap: 'existing-fooditem-unit-conversion-gap' },
  { name: 'Ghee', resolutionGap: 'existing-fooditem-unit-conversion-gap' },
];

const ORIGIN_CRITERIA = {
  plant: 'A whole or minimally processed food of plant origin - vegetables, fruits, grains, pulses, nuts, seeds.',
  animal_meat_fish_egg: 'Meat, poultry, fish, seafood, or eggs.',
  dairy: 'Milk, curd/yogurt, paneer, cheese, cream, and other milk-based foods (not ghee/butter - see fat_animal).',
  oil_plant: 'A plant-derived cooking oil (sunflower, mustard, groundnut, coconut, olive, etc).',
  fat_animal: 'An animal-derived fat used as a cooking or spreading fat - ghee, butter, lard.',
  processed_packaged: 'A packaged, processed, or manufactured food - bread, sauces, condiments, snacks, ready-mixes, broths.',
  spice_blend: 'A spice, herb, or spice blend (garam masala, chaat masala, sambar powder, or an individual spice/herb).',
  salt_mineral: 'Salt, or a mineral/leavening agent such as baking soda or baking powder.',
  water: 'Plain water.',
};

const LOOKUP_ROUTE_CRITERIA = {
  standard_raw_food: 'A common, unambiguous whole food with a direct IFCT/USDA composition entry (e.g. Onion, Tomato, Toor Dal).',
  regional_indian: 'An Indian regional food best matched in IFCT 2017 (NIN) first - Indian vegetables, pulses, regional dairy forms, regional dishes.',
  branded_or_blend: 'A branded product or a multi-ingredient blend with no single canonical composition (spice blends, packaged sauces, broths, mixes) - needs label data or a composition estimate.',
  ambiguous_name: 'The name alone does not identify one specific food (e.g. a bare "Masala" or "Flour") - needs disambiguation before it can be researched at all.',
};

const RESEARCH_PRIORITY_LEVELS = [
  'Used in 0-1 recipes in this catalog - low visibility, research last.',
  'Used in 2-4 recipes - moderate visibility.',
  'Used in 5-9 recipes - meaningful visibility across the catalog.',
  'Used in 10+ recipes, or a defining ingredient of a signature/flagship dish - high visibility, research first.',
];

const NUTRITION_SUSPICION_LEVELS = [
  'Macros look internally consistent: the Atwater estimate (4*protein + 4*carbs + 9*fat) is close to the stated calories, and the current-version figure is not wildly different from the legacy Recipe.nutrition figure for the same dish.',
  'One mild inconsistency: a modest Atwater/calorie mismatch or a moderate base-vs-version difference, plausibly just normal rounding/recipe-editing drift.',
  'A clear inconsistency: the Atwater estimate is well off the stated calories, or the base and version figures differ enough to suggest one of them used different ingredient quantities/sources.',
  'Multiple or severe inconsistencies: implausible on their face (e.g. calories far exceed what the ingredient quantities could produce, or protein/fat/carbs grams alone already exceed the stated calories) - needs the closest look during research.',
];

async function loadUsageIndex() {
  const baseline = JSON.parse(fs.readFileSync(AUDIT_BASELINE_PATH, 'utf8'));
  const byNormalizedName = new Map(); // normalizedName -> { count, sampleRecipes: [] }
  for (const rv of baseline.recipeVersions) {
    const allNames = [...(rv.ingredientNames || []), ...(rv.unresolvedIngredientNames || [])];
    const seenThisRecipe = new Set();
    for (const raw of allNames) {
      const key = raw.trim().toLowerCase();
      if (seenThisRecipe.has(key)) continue; // count each recipe once per ingredient
      seenThisRecipe.add(key);
      if (!byNormalizedName.has(key)) byNormalizedName.set(key, { count: 0, sampleRecipes: [] });
      const entry = byNormalizedName.get(key);
      entry.count += 1;
      if (entry.sampleRecipes.length < 3) entry.sampleRecipes.push(rv.recipeName);
    }
  }
  return byNormalizedName;
}

/** Runs one batch of FoodItem-like items { name, normalizedName, usageCount, sampleRecipes } through Jev. */
async function triageBatch(items) {
  const state = {
    foodItems: items.map((it) => ({
      name: it.name,
      recipeUsageCount: it.usageCount,
      sampleRecipesUsingIt: it.sampleRecipes,
    })),
  };

  const questions = {};
  items.forEach((_, i) => {
    questions[`origin_${i}`] = {
      type: 'choice',
      instructions: `What is the origin/category of the ingredient at \`foodItems[${i}]\` (name: \`foodItems[${i}].name\`)?`,
      criteria: ORIGIN_CRITERIA,
    };
    questions[`cholesterol_zero_${i}`] = {
      type: 'noul',
      instructions: `Is dietary cholesterol structurally/definitionally zero for \`foodItems[${i}].name\` - i.e. is it a food of purely plant origin, where cholesterol (an animal-derived compound) cannot be present at all, regardless of brand or preparation?`,
    };
    questions[`trans_fat_possible_${i}`] = {
      type: 'noul',
      instructions: `Could \`foodItems[${i}].name\` plausibly contain meaningful trans fat - e.g. it is a hydrogenated fat/vanaspati, a ruminant dairy product or ghee (natural trans fats), or a processed/packaged/fried food that commonly uses partially hydrogenated oil? Answer 1 (yes) if there's a real possibility worth checking a source for, 0 (no) only if trans fat is essentially impossible for this food (e.g. a fresh vegetable or fruit).`,
    };
    questions[`sodium_significant_${i}`] = {
      type: 'noul',
      instructions: `Does \`foodItems[${i}].name\` likely carry nutritionally significant sodium - e.g. it is salt itself, a salted/pickled/packaged food, a spice blend that includes salt, or a broth/stock? Answer 0 (no) for a plain fresh fruit/vegetable/grain/pulse with no added salt.`,
    };
    questions[`lookup_route_${i}`] = {
      type: 'choice',
      instructions: `Which food-composition lookup route best fits \`foodItems[${i}].name\`?`,
      criteria: LOOKUP_ROUTE_CRITERIA,
    };
    questions[`research_priority_${i}`] = {
      type: 'score',
      instructions: `Given \`foodItems[${i}].recipeUsageCount\` (recipes in this catalog that use it) and \`foodItems[${i}].sampleRecipesUsingIt\`, how high should researching this ingredient's micronutrients be prioritized relative to the rest of the catalog?`,
      criteria: RESEARCH_PRIORITY_LEVELS,
    };
  });

  const { answers, usage } = await askJev({ state, questions });
  return items.map((item, i) => {
    const origin = answers[`origin_${i}`];
    const cholZero = answers[`cholesterol_zero_${i}`];
    const transFat = answers[`trans_fat_possible_${i}`];
    const sodium = answers[`sodium_significant_${i}`];
    const route = answers[`lookup_route_${i}`];
    const priority = answers[`research_priority_${i}`];

    const notes = [];
    const lowConf = (label, ans) => {
      if (ans && ans.confidence !== undefined && ans.confidence < CONFIDENCE_BAR) {
        notes.push(`${label}: Jev confidence ${ans.confidence.toFixed(2)} < ${CONFIDENCE_BAR} - needs a Claude-session decision before/while researching, not auto-trusted.`);
      }
    };
    lowConf('origin', origin);
    lowConf('lookup_route', route);
    if (cholZero && cholZero.noul > 0.3 && cholZero.noul < 0.7) notes.push(`cholesterol_definitionally_zero: near-uncertain (${cholZero.noul.toFixed(2)}) - decide explicitly during research, don't treat as a rule:plant-cholesterol match without checking.`);
    if (transFat && transFat.noul > 0.3 && transFat.noul < 0.7) notes.push(`trans_fat_possible: near-uncertain (${transFat.noul.toFixed(2)}) - check a source rather than assuming either way.`);
    if (sodium && sodium.noul > 0.3 && sodium.noul < 0.7) notes.push(`sodium_significant: near-uncertain (${sodium.noul.toFixed(2)}).`);

    return {
      name: item.name,
      normalizedName: item.normalizedName,
      foodItemId: item.foodItemId || null,
      resolutionGap: item.resolutionGap || null,
      recipeUsageCount: item.usageCount,
      sampleRecipesUsingIt: item.sampleRecipes,
      origin: origin ? { choice: origin.choice, confidence: origin.confidence } : null,
      cholesterolDefinitionallyZero: cholZero ? cholZero.noul : null,
      transFatPossible: transFat ? transFat.noul : null,
      sodiumSignificant: sodium ? sodium.noul : null,
      lookupRoute: route ? { choice: route.choice, confidence: route.confidence } : null,
      researchPriorityScore: priority ? priority.score : null,
      lowConfidenceNotes: notes,
      jevCallUsage: usage,
    };
  });
}

async function main() {
  console.log(`DB: ${(process.env.MONGODB_URI || '').replace(/\/\/[^@]+@/, '//<redacted>@')}`);
  if (!/localhost|127\.0\.0\.1/.test(process.env.MONGODB_URI || '')) {
    console.error('Refusing to run: MONGODB_URI does not look like local staging (expected localhost:27018). Set it explicitly before running this script.');
    process.exit(1);
  }
  await connectDB();
  const FoodItem = require('../models/FoodItem');

  const usageIndex = await loadUsageIndex();

  const realFoodItems = await FoodItem.find({}).select('name normalizedName').lean();
  const items = realFoodItems.map((fi) => {
    const usage = usageIndex.get(fi.normalizedName) || { count: 0, sampleRecipes: [] };
    return {
      name: fi.name,
      normalizedName: fi.normalizedName,
      foodItemId: String(fi._id),
      resolutionGap: null,
      usageCount: usage.count,
      sampleRecipes: usage.sampleRecipes,
    };
  });

  for (const u of UNRESOLVED_NAMES) {
    const key = u.name.trim().toLowerCase();
    const usage = usageIndex.get(key) || { count: 0, sampleRecipes: [] };
    items.push({
      name: u.name,
      normalizedName: key,
      foodItemId: null,
      resolutionGap: u.resolutionGap,
      usageCount: usage.count,
      sampleRecipes: usage.sampleRecipes,
    });
  }

  console.log(`Triaging ${items.length} items (${realFoodItems.length} FoodItems + ${UNRESOLVED_NAMES.length} unresolved names) in batches of ${BATCH_SIZE}...\n`);

  const results = [];
  let totalCost = 0;
  let totalCalls = 0;
  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const batch = items.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(items.length / BATCH_SIZE);
    process.stdout.write(`  batch ${batchNum}/${totalBatches} (${batch.length} items)... `);
    const batchResults = await triageBatch(batch);
    results.push(...batchResults);
    totalCalls += 1;
    const inTok = batchResults[0]?.jevCallUsage?.input_tokens || 0;
    const outTok = batchResults[0]?.jevCallUsage?.output_tokens || 0;
    const cost = inTok * (42 / 1_000_000_000);
    totalCost += cost;
    console.log(`ok (${inTok} in / ${outTok} out tokens, ~$${cost.toFixed(6)})`);
  }

  // Drop the per-result jevCallUsage payload (batch-level, duplicated per item) before writing.
  const cleaned = results.map(({ jevCallUsage, ...rest }) => rest);
  cleaned.sort((a, b) => (b.researchPriorityScore ?? -1) - (a.researchPriorityScore ?? -1));

  fs.writeFileSync(
    OUT_PATH,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        totalItems: cleaned.length,
        totalJevCalls: totalCalls,
        estimatedTotalCostUsd: totalCost,
        confidenceBar: CONFIDENCE_BAR,
        items: cleaned,
      },
      null,
      2
    )
  );

  const lowConfCount = cleaned.filter((r) => r.lowConfidenceNotes.length > 0).length;
  const byRoute = {};
  for (const r of cleaned) {
    const k = r.lookupRoute?.choice || 'unknown';
    byRoute[k] = (byRoute[k] || 0) + 1;
  }

  console.log(`\nWrote ${cleaned.length} triaged items to ${OUT_PATH}`);
  console.log(`Jev calls: ${totalCalls}, estimated total cost: $${totalCost.toFixed(6)}`);
  console.log(`Items with a low-confidence flag needing a Claude-session decision: ${lowConfCount}`);
  console.log('lookup_route distribution:', byRoute);
  console.log('\nTop 10 by research priority:');
  for (const r of cleaned.slice(0, 10)) {
    console.log(`  ${r.researchPriorityScore?.toFixed(1)}  ${r.name} (used in ${r.recipeUsageCount} recipes) - route: ${r.lookupRoute?.choice}`);
  }

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
