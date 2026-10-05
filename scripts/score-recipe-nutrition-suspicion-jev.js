/**
 * fill-recipe-micronutrients (openspec) section 3.2: a per-recipe
 * `nutrition_suspicion` score (0-3) flagging recipes whose MACRO figures
 * look internally inconsistent - not a micronutrient concern, but
 * discovered as a natural byproduct of building this change's audit
 * tooling, and worth surfacing since a suspicious base recipe's numbers
 * would otherwise quietly feed into the "is this FoodItem's data
 * plausible" question during research (section 4) without anyone having
 * flagged the recipe-level number as questionable to begin with.
 *
 * Two purely-computed (non-Jev) signals feed each recipe's question:
 *   - atwaterDeltaPct: |statedCalories - (4*protein + 4*carbs + 9*fat)| /
 *     max(statedCalories, computed, 1) - how far the V1 RecipeVersion's own
 *     stated calories are from what its own protein/carbs/fat would predict.
 *   - baseVsVersionDeltaPct: |Recipe.nutrition.calories -
 *     RecipeVersion.nutritionPerServing.calories| / max(...) - how far the
 *     dietician's original hand-authored figure differs from the real
 *     ingredient-derived V1 figure computed by recipeVersioningService.js.
 * Jev turns these two numbers (plus the recipe name/ingredients, for
 * qualitative judgment a bare percentage can't capture - e.g. a dish that's
 * mostly water/broth legitimately has a very different profile than a
 * dense dessert) into one 0-3 suspicion bucket per recipe - see
 * NUTRITION_SUSPICION_LEVELS for exactly what each bucket means. Jev
 * classifies only; nothing here changes any stored nutrition value.
 *
 * Uses ONLY V1 RecipeVersions (a V2+ was deliberately dietician-edited, so
 * a base-vs-version delta there reflects an intentional change, not a data
 * quality signal).
 *
 * Usage (staging only - never point MONGODB_URI at prod for this):
 *   MONGODB_URI="mongodb://localhost:27018/docwellness_staging" node scripts/score-recipe-nutrition-suspicion-jev.js
 *
 * Output: scripts/data/recipe-nutrition-suspicion.json
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const connectDB = require('../config/database');
const { askJev } = require('../utils/jevClient');

const OUT_PATH = path.join(__dirname, 'data', 'recipe-nutrition-suspicion.json');
const BATCH_SIZE = 20;
const CONFIDENCE_BAR = 0.7;

const NUTRITION_SUSPICION_LEVELS = [
  'Macros look internally consistent: the Atwater estimate (4*protein + 4*carbs + 9*fat) is close to the stated calories, and the current-version figure is not wildly different from the legacy Recipe.nutrition figure for the same dish.',
  'One mild inconsistency: a modest Atwater/calorie mismatch or a moderate base-vs-version difference, plausibly just normal rounding/recipe-editing drift.',
  'A clear inconsistency: the Atwater estimate is well off the stated calories, or the base and version figures differ enough to suggest one of them used different ingredient quantities/sources.',
  'Multiple or severe inconsistencies: implausible on their face (e.g. calories far exceed what the ingredient quantities could produce, or protein/fat/carbs grams alone already exceed the stated calories) - needs the closest look during research.',
];

function pct(a, b) {
  if (typeof a !== 'number' || typeof b !== 'number') return null;
  return Math.round((Math.abs(a - b) / Math.max(a, b, 1)) * 10000) / 100;
}

async function main() {
  console.log(`DB: ${(process.env.MONGODB_URI || '').replace(/\/\/[^@]+@/, '//<redacted>@')}`);
  if (!/localhost|127\.0\.0\.1/.test(process.env.MONGODB_URI || '')) {
    console.error('Refusing to run: MONGODB_URI does not look like local staging (expected localhost:27018).');
    process.exit(1);
  }
  await connectDB();
  const { Recipe, RecipeVersion, FoodItem } = require('../models');

  const v1s = await RecipeVersion.find({ versionNumber: 1 }).lean();
  const recipeIds = v1s.map((v) => v.parentRecipeId);
  const recipes = await Recipe.find({ _id: { $in: recipeIds } }).select('name nutrition ingredients').lean();
  const recipeById = new Map(recipes.map((r) => [String(r._id), r]));
  const foodItemIds = v1s.flatMap((v) => (v.ingredients || []).map((i) => i.foodItemId));
  const foodItems = await FoodItem.find({ _id: { $in: foodItemIds } }).select('name').lean();
  const foodItemNameById = new Map(foodItems.map((f) => [String(f._id), f.name]));

  const candidates = v1s.map((v) => {
    const recipe = recipeById.get(String(v.parentRecipeId));
    const stated = v.nutritionPerServing?.calories ?? null;
    const computedAtwater =
      typeof v.nutritionPerServing?.protein === 'number' &&
      typeof v.nutritionPerServing?.carbs === 'number' &&
      typeof v.nutritionPerServing?.fats === 'number'
        ? 4 * v.nutritionPerServing.protein + 4 * v.nutritionPerServing.carbs + 9 * v.nutritionPerServing.fats
        : null;
    const atwaterDeltaPct = pct(stated, computedAtwater);
    const baseVsVersionDeltaPct = pct(recipe?.nutrition?.calories, stated);
    return {
      recipeId: String(v.parentRecipeId),
      recipeVersionId: String(v._id),
      name: recipe?.name || v.name,
      ingredients: (v.ingredients || []).map((i) => ({
        name: foodItemNameById.get(String(i.foodItemId)) || '(unresolved)',
        rawQuantity: i.rawQuantity,
        unit: i.unit,
      })),
      statedCalories: stated,
      computedAtwaterCalories: computedAtwater !== null ? Math.round(computedAtwater * 100) / 100 : null,
      atwaterDeltaPct,
      baseNutritionCalories: recipe?.nutrition?.calories ?? null,
      baseVsVersionDeltaPct,
    };
  });

  console.log(`Scoring ${candidates.length} V1 recipe versions in batches of ${BATCH_SIZE}...\n`);

  const results = [];
  let totalCost = 0;
  let totalCalls = 0;
  for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
    const batch = candidates.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(candidates.length / BATCH_SIZE);
    process.stdout.write(`  batch ${batchNum}/${totalBatches} (${batch.length} recipes)... `);

    const state = {
      recipes: batch.map((c) => ({
        name: c.name,
        ingredients: c.ingredients,
        statedCaloriesPerServing: c.statedCalories,
        atwaterEstimatedCalories: c.computedAtwaterCalories,
        atwaterDeltaPct: c.atwaterDeltaPct,
        legacyBaseRecipeCalories: c.baseNutritionCalories,
        baseVsVersionDeltaPct: c.baseVsVersionDeltaPct,
      })),
    };
    const questions = {};
    batch.forEach((_, idx) => {
      questions[`suspicion_${idx}`] = {
        type: 'score',
        instructions: `Given \`recipes[${idx}]\`'s name, ingredients+quantities, stated calories, Atwater-estimated calories (from its own protein/carbs/fat), and the delta versus its legacy base-recipe calorie figure, how internally consistent/plausible are this recipe's macro numbers?`,
        criteria: NUTRITION_SUSPICION_LEVELS,
      };
    });

    const { answers, usage } = await askJev({ state, questions });
    batch.forEach((c, idx) => {
      const ans = answers[`suspicion_${idx}`];
      results.push({
        ...c,
        nutritionSuspicionScore: ans?.score ?? null,
        nutritionSuspicionConfidence: ans?.confidence ?? null,
        lowConfidence: typeof ans?.confidence === 'number' && ans.confidence < CONFIDENCE_BAR,
      });
    });
    totalCalls += 1;
    const cost = (usage?.input_tokens || 0) * (42 / 1_000_000_000);
    totalCost += cost;
    console.log(`ok (${usage?.input_tokens || 0} in / ${usage?.output_tokens || 0} out tokens, ~$${cost.toFixed(6)})`);
  }

  results.sort((a, b) => (b.nutritionSuspicionScore ?? -1) - (a.nutritionSuspicionScore ?? -1));

  fs.writeFileSync(
    OUT_PATH,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        totalRecipes: results.length,
        totalJevCalls: totalCalls,
        estimatedTotalCostUsd: totalCost,
        confidenceBar: CONFIDENCE_BAR,
        recipes: results,
      },
      null,
      2
    )
  );

  const highSuspicion = results.filter((r) => (r.nutritionSuspicionScore ?? 0) >= 2);
  console.log(`\nWrote ${results.length} scored recipes to ${OUT_PATH}`);
  console.log(`Jev calls: ${totalCalls}, estimated total cost: $${totalCost.toFixed(6)}`);
  console.log(`High-suspicion recipes (score >= 2): ${highSuspicion.length}`);
  for (const r of highSuspicion.slice(0, 15)) {
    console.log(`  ${r.nutritionSuspicionScore?.toFixed(1)}  ${r.name} - atwaterDelta=${r.atwaterDeltaPct}%, baseVsVersionDelta=${r.baseVsVersionDeltaPct}%`);
  }

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
