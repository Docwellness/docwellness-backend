/**
 * v4.0's Step 2 engine: fills every {week, dayGroup, servingTime} slot with
 * a PlanItem pointing at a Recipe's V1 RecipeVersion, exactly as authored -
 * unlike services/recipeSelectionEngine.js's servingMultiplier-solving
 * (there isn't any - that file only SCORES candidates, it never solved a
 * multiplier either), generateMenu here deliberately does NO scaling at
 * all. Hitting a patient's calorie target is entirely deferred to Step 3's
 * services/ingredientAutoBalanceService.js. This is a real, visible
 * behavior change versus the old single-shot generation - Step 2's output
 * is calorically rougher by design, see the "Diet Plan v4.0" plan doc's
 * Phase 3b.
 *
 * Reuses recipeSelectionEngine.js's scoring/selection machinery
 * (mulberry32/seedFromString/selectMainAndAccompaniment) and
 * dietPlanOptions.js's buildRecipesByServingTimeMap bucketing almost
 * entirely unchanged - the only real difference from the old engine is the
 * candidate pool itself: RecipeVersion V1 documents (via
 * buildEligibleV1Pool), not Recipe documents directly, and the output is
 * real PlanItem/DayPlan/MealSlotPlan documents, not a JSON blob.
 */

const { DAY_GROUPS, NON_VEG_ALLOWED_DAY_GROUPS } = require('../utils/dayGroups');
const { REQUIRED_SERVING_TIMES } = require('../utils/servingTimes');
const { buildRecipesByServingTimeMap } = require('../utils/dietPlanOptions');
const { slotCalorieTarget } = require('./nutritionCalculatorService');
const { mulberry32, seedFromString, selectMainAndAccompaniment } = require('./recipeSelectionEngine');
const { Recipe, RecipeVersion, DayPlan, MealSlotPlan, PlanItem } = require('../models');

/**
 * Builds the candidate pool for generation: every Active Recipe belonging
 * to this dietician whose V1 RecipeVersion is Active AND fully resolved
 * (hasUnresolvedIngredients: false) - the Phase 0 data-coverage gate,
 * enforced here in code rather than left to a UI-level warning. A recipe
 * with no V1 yet (pre-hook data that hasn't been backfilled - see
 * scripts/backfill-recipe-versions.js) or an unresolved V1 is simply
 * excluded, same "fall back to the next candidate" spirit
 * recipeSelectionEngine.js already uses for other exclusions.
 */
async function buildEligibleV1Pool({ dieticianId, allergies = [] }) {
  const recipes = await Recipe.find({ dieticianId, status: 'Active' }).select(
    'name servingTime tags dietaryHabits allergens category'
  );
  if (recipes.length === 0) return [];

  const v1s = await RecipeVersion.find({
    parentRecipeId: { $in: recipes.map((recipe) => recipe._id) },
    versionNumber: 1,
    status: 'Active',
    hasUnresolvedIngredients: false,
  }).select('parentRecipeId nutritionPerServing mealSlotSuitability');
  const v1ByRecipeId = new Map(v1s.map((v1) => [String(v1.parentRecipeId), v1]));

  const candidates = [];
  for (const recipe of recipes) {
    const v1 = v1ByRecipeId.get(String(recipe._id));
    if (!v1) continue;
    if (allergies.length > 0 && recipe.allergens?.some((allergen) => allergies.includes(allergen))) continue;

    candidates.push({
      id: String(recipe._id),
      recipeVersionId: v1._id,
      calories: v1.nutritionPerServing?.calories ?? null,
      protein: v1.nutritionPerServing?.protein ?? null,
      carbs: v1.nutritionPerServing?.carbs ?? null,
      fats: v1.nutritionPerServing?.fats ?? null,
      mealSlotSuitability: v1.mealSlotSuitability,
      servingTime: recipe.servingTime,
      tags: recipe.tags,
      category: recipe.category,
      dietaryHabits: recipe.dietaryHabits,
    });
  }
  return candidates;
}

/**
 * Fills every slot for the given weeks with PlanItems. A regenerate
 * (calling this again for a plan/week that already has DayPlan/MealSlotPlan
 * documents) REPLACES that slot's PlanItems rather than appending - matches
 * the old engine's "generate" semantics (a fresh generation for a week
 * discards the previous one, not layers on top of it).
 *
 * Returns { createdPlanItemIds, unfillableSlots } - unfillableSlots is a
 * list of {week, dayGroup, servingTime} the pool had nothing eligible for
 * (e.g. every recipe for that slot still has unresolved ingredients) so the
 * caller/dietician can see exactly what's missing rather than a silently
 * incomplete plan.
 */
async function generateMenu({
  dietPlanId,
  patientId,
  dieticianId,
  allergies = [],
  weekNumbers = [1, 2, 3, 4],
  restrictNonVegToDayGroups = false,
  totalCalories = null,
  mealDistribution = null,
}) {
  const pool = await buildEligibleV1Pool({ dieticianId, allergies });
  const recipesByServingTime = buildRecipesByServingTimeMap(pool);

  const seedBase = seedFromString(JSON.stringify({ dietPlanId: String(dietPlanId), weekNumbers: [...weekNumbers].sort() }));
  const recentlyUsedByServingTime = new Map();
  const createdPlanItemIds = [];
  const unfillableSlots = [];

  for (const week of weekNumbers) {
    for (const dayGroup of DAY_GROUPS) {
      const dayPlan = await DayPlan.findOneAndUpdate(
        { dietPlanId, week, dayGroup },
        { $setOnInsert: { dietPlanId, patientId, week, dayGroup } },
        { upsert: true, returnDocument: 'after' }
      );

      for (const servingTime of REQUIRED_SERVING_TIMES) {
        const slotPool = recipesByServingTime[servingTime] || [];
        const eligible =
          restrictNonVegToDayGroups && !NON_VEG_ALLOWED_DAY_GROUPS.includes(dayGroup)
            ? slotPool.filter((recipe) => !recipe.dietaryHabits?.nonVegetarian)
            : slotPool;

        const mealSlot = await MealSlotPlan.findOneAndUpdate(
          { dayPlanId: dayPlan._id, servingTime },
          { $setOnInsert: { dayPlanId: dayPlan._id, servingTime } },
          { upsert: true, returnDocument: 'after' }
        );

        // A regenerate replaces this slot's items, not appends to them.
        await PlanItem.deleteMany({ mealSlotId: mealSlot._id });

        if (eligible.length === 0) {
          unfillableSlots.push({ week, dayGroup, servingTime });
          continue;
        }

        const target = slotCalorieTarget({ mealDistribution, servingTime, totalCalories, allServingTimes: REQUIRED_SERVING_TIMES });
        const recentlyUsed = recentlyUsedByServingTime.get(servingTime) || [];
        const rand = mulberry32(seedFromString(`${seedBase}-${week}-${dayGroup}-${servingTime}`))();

        const { main, accompaniment } = selectMainAndAccompaniment({
          eligible,
          servingTime,
          target,
          macroStrategy: null,
          recentlyUsed,
          rand,
        });

        const mainItem = await PlanItem.create({
          mealSlotId: mealSlot._id,
          recipeVersionId: main.recipeVersionId,
          calculatedNutrition: { calories: main.calories, protein: main.protein, carbs: main.carbs, fats: main.fats },
        });
        createdPlanItemIds.push(mainItem._id);
        recentlyUsed.push(main.id);

        if (accompaniment) {
          const accompanimentItem = await PlanItem.create({
            mealSlotId: mealSlot._id,
            recipeVersionId: accompaniment.recipeVersionId,
            isLinkedComponent: true,
            parentRecipeId: main.id,
            calculatedNutrition: {
              calories: accompaniment.calories,
              protein: accompaniment.protein,
              carbs: accompaniment.carbs,
              fats: accompaniment.fats,
            },
          });
          createdPlanItemIds.push(accompanimentItem._id);
          recentlyUsed.push(accompaniment.id);
        }

        recentlyUsedByServingTime.set(servingTime, recentlyUsed);
      }
    }
  }

  return { createdPlanItemIds, unfillableSlots };
}

module.exports = { buildEligibleV1Pool, generateMenu };
