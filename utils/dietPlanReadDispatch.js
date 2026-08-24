/**
 * v4.0's model-aware read dispatch for the patient-facing app. Kept as a
 * separate sibling to dietPlanLegacyView.js (rather than editing that file)
 * so the days-array path stays byte-for-byte untouched - see the "Diet Plan
 * v4.0" plan doc's Phase 2c/2d for why this is deliberately a thin wrapper,
 * not a rewrite.
 *
 * Currently wired into controllers/patient/dietController.js's
 * getActiveDietPlanForPatient only (the main "get my diet plan" endpoint) -
 * the other 4 days[]-reading call sites (meal-log screens, groceries, etc.)
 * still call dietPlanLegacyView.js's getFinalizedWeeks directly, unchanged,
 * and would need the same mechanical swap later to support a plan-item
 * patient there too.
 */

const { getFinalizedWeeks } = require('./dietPlanLegacyView');
const { DayPlan, MealSlotPlan, PlanItem, SupplementItem, RecipeVersion, FoodItem } = require('../models');

// A single Recipe can be prescribed at more than one PlanItem (different
// day/slot, or the same slot across weeks) at DIFFERENT versions - e.g. the
// dietician edits ingredients for Monday's Oats Porridge (Step 3) while
// Tuesday's Oats Porridge stays on V1. `dailyMeals[].recipeId` normally IS
// the real Recipe._id, and every occurrence sharing a recipeId would
// otherwise collapse onto the SAME `recipes[recipeId]` entry client-side -
// silently applying one occurrence's edited quantities to every other
// occurrence of that recipe. Suffixing with the version number gives each
// distinct (recipe, version) pair its own key, so
// controllers/patient/dietController.js can synthesize a separate `recipes`
// entry per version - invisible to the Flutter client, which already only
// ever treats recipeId as an opaque lookup key into `recipes`.
const VERSIONED_ID_SEPARATOR = '::v';

function versionedRecipeKey(recipeId, versionNumber) {
  return `${recipeId}${VERSIONED_ID_SEPARATOR}${versionNumber}`;
}

/** Inverse of versionedRecipeKey - the real Recipe._id to fetch/clone from. Passing a plain (non-versioned) id back through is a no-op, so this is always safe to call regardless of which model produced the id. */
function baseRecipeIdFromKey(key) {
  const idx = key.indexOf(VERSIONED_ID_SEPARATOR);
  return idx === -1 ? key : key.slice(0, idx);
}

/**
 * Synthesizes the legacy {weeks:[{week,dailyMeals}]} shape from
 * DayPlan/MealSlotPlan/PlanItem, PLUS two additive extras a days-array
 * response never has:
 *   - recipeVersionOverrides: keyed by the underlying Recipe's _id, the
 *     EXACT ingredients/steps actually prescribed (from the highest
 *     versionNumber PlanItem seen for that recipe) - overrides the base
 *     Recipe's own ingredients/instructions when a dietician has created a
 *     custom version (V2+) for this patient. A recipe never edited stays on
 *     V1, whose ingredients/steps are copied from the base Recipe anyway, so
 *     the override is a no-op difference in that case.
 *   - supplementScheduleByWeek: same shape SupplementScheduleEntry already
 *     expects client-side, sourced from SupplementItem instead of
 *     days[].meals[].supplements[].
 *
 * dailyMeals[].recipeId is the underlying Recipe's id (RecipeVersion.parentRecipeId),
 * not the RecipeVersion's own id - this is what lets the EXISTING
 * Recipe.find({_id:{$in:recipeIds}}) fetch in getActiveDietPlanForPatient
 * keep working unchanged to populate the base recipe/image/tags/etc, with
 * ingredients/instructions/nutrition/servingSize/components overridden
 * afterward for accuracy. `servings` is always 1 (there is no
 * servingMultiplier equivalent in this model - a RecipeVersion's
 * ingredients ARE the exact prescribed amount) - CRITICALLY, the override
 * also pins servingSize.quantity to 1, because the client
 * (diet_controller.dart::getRecipesForServing) computes
 * `ratio = meal.servings / baseRecipe.servingSize.quantity` and would
 * otherwise divide by the base recipe's real (often non-1) servingSize,
 * silently mis-scaling nutrition for every plan-item meal. Pinning both
 * sides to 1 makes that ratio always resolve to exactly 1 (no rescale),
 * which is correct - the RecipeVersion's own nutritionPerServing (also
 * overridden below) is already the real, final prescribed number.
 *
 * The override ALSO synthesizes `components` (one entry per ingredient,
 * {label, quantity, unit}) from the version's real ingredients - not just
 * cosmetic: food_card.dart's FoodCard widget only falls back to showing
 * servingSize.quantity/unit as a single pill when `components` is EMPTY
 * (see its own doc comment), and a legacy recipe authored before
 * `components` existed could have none set, which combined with the
 * servingSize.quantity=1 pin above would otherwise display a misleading
 * "1 g" to the patient. Deriving components from the version's ingredients
 * fixes that AND is a more accurate display than the base recipe's own
 * (possibly-stale, if this is a V2+) components would have been anyway.
 */
async function buildPlanItemPatientView(dietPlan) {
  const dayPlans = await DayPlan.find({ dietPlanId: dietPlan._id }).lean();
  const dayPlanIds = dayPlans.map((dp) => dp._id);
  const mealSlots = await MealSlotPlan.find({ dayPlanId: { $in: dayPlanIds } }).lean();
  const mealSlotIds = mealSlots.map((ms) => ms._id);
  const planItems = await PlanItem.find({ mealSlotId: { $in: mealSlotIds } }).lean();
  const supplementItems = await SupplementItem.find({ mealSlotId: { $in: mealSlotIds } }).lean();

  const recipeVersionIds = planItems.map((item) => item.recipeVersionId);
  const recipeVersions = await RecipeVersion.find({ _id: { $in: recipeVersionIds } }).lean();
  const versionById = new Map(recipeVersions.map((v) => [String(v._id), v]));

  const foodItemIds = recipeVersions.flatMap((v) => (v.ingredients || []).map((ing) => ing.foodItemId));
  const foodItems = await FoodItem.find({ _id: { $in: foodItemIds } }).select('name').lean();
  const foodItemNameById = new Map(foodItems.map((f) => [String(f._id), f.name]));

  const dayPlanById = new Map(dayPlans.map((dp) => [String(dp._id), dp]));
  const mealSlotById = new Map(mealSlots.map((ms) => [String(ms._id), ms]));

  const weeksMap = new Map();
  const recipeVersionOverrides = {};

  for (const item of planItems) {
    const mealSlot = mealSlotById.get(String(item.mealSlotId));
    const dayPlan = mealSlot && dayPlanById.get(String(mealSlot.dayPlanId));
    const version = versionById.get(String(item.recipeVersionId));
    if (!mealSlot || !dayPlan || !version) continue;

    const recipeId = String(version.parentRecipeId);
    const versionedId = versionedRecipeKey(recipeId, version.versionNumber);
    if (!weeksMap.has(dayPlan.week)) weeksMap.set(dayPlan.week, { week: dayPlan.week, dailyMeals: [] });
    weeksMap.get(dayPlan.week).dailyMeals.push({
      dayGroup: dayPlan.dayGroup,
      servingTime: mealSlot.servingTime,
      recipeId: versionedId,
      servings: 1,
    });

    // Every PlanItem referencing the same RecipeVersion._id computes an
    // identical versionedId and identical override content (versionNumber is
    // unique per parentRecipeId - see RecipeVersion's compound index) - a
    // second occurrence just harmlessly recomputes the same value, not a
    // conflict to resolve like the old highest-version-wins logic this
    // replaced.
    if (!recipeVersionOverrides[versionedId]) {
      recipeVersionOverrides[versionedId] = {
        baseRecipeId: recipeId,
        versionNumber: version.versionNumber,
        steps: version.steps || [],
        ingredients: (version.ingredients || []).map((ingredient) => ({
          name: foodItemNameById.get(String(ingredient.foodItemId)) || 'Ingredient',
          quantity: ingredient.rawQuantity,
          unit: ingredient.unit,
          image: null,
          isScalable: true,
        })),
        nutritionPerServing: {
          calories: version.nutritionPerServing?.calories ?? 0,
          protein: version.nutritionPerServing?.protein ?? 0,
          carbs: version.nutritionPerServing?.carbs ?? 0,
          fats: version.nutritionPerServing?.fats ?? 0,
          fiber: version.nutritionPerServing?.fiber ?? 0,
        },
        // Prefer the version's real whole-dish serving unit (e.g. "2 piece"
        // for a paratha, "1 bowl" for khichdi) - only synthesize one
        // ingredient-per-pseudo-component when a version predates the
        // `components` field (created before this field existed), so an old
        // version still renders something rather than nothing.
        components: version.components?.length
          ? version.components.map((component) => ({ label: component.label, quantity: component.quantity, unit: component.unit }))
          : (version.ingredients || []).map((ingredient) => ({
              label: foodItemNameById.get(String(ingredient.foodItemId)) || 'Ingredient',
              quantity: ingredient.rawQuantity,
              unit: ingredient.unit,
            })),
      };
    }
  }

  const supplementScheduleByWeek = {};
  for (const supplement of supplementItems) {
    const mealSlot = mealSlotById.get(String(supplement.mealSlotId));
    const dayPlan = mealSlot && dayPlanById.get(String(mealSlot.dayPlanId));
    if (!mealSlot || !dayPlan) continue;
    if (!supplementScheduleByWeek[dayPlan.week]) supplementScheduleByWeek[dayPlan.week] = [];
    supplementScheduleByWeek[dayPlan.week].push({
      dayGroup: dayPlan.dayGroup,
      servingTime: mealSlot.servingTime,
      supplementId: String(supplement.supplementRecipeId),
      dosage: supplement.dosage || null,
      instructions: supplement.instructions || null,
      timingAnchor: supplement.timingAnchor || 'with',
    });
  }

  return {
    weeks: Array.from(weeksMap.values()),
    recipeVersionOverrides,
    supplementScheduleByWeek,
  };
}

/**
 * Returns just the weeks[] - a drop-in replacement for
 * dietPlanLegacyView.js's getFinalizedWeeks at a call site that only needs
 * dailyMeals, not the recipeVersionOverrides/supplementScheduleByWeek
 * extras (see buildPlanItemPatientView for those). Now async (unlike
 * getFinalizedWeeks) since the plan-item branch needs real DB queries -
 * every caller must await this.
 */
async function getPatientVisibleWeeks(dietPlan) {
  if (dietPlan?.dataModel === 'plan-item') {
    const { weeks } = await buildPlanItemPatientView(dietPlan);
    return weeks;
  }
  return getFinalizedWeeks(dietPlan);
}

module.exports = { getPatientVisibleWeeks, buildPlanItemPatientView, versionedRecipeKey, baseRecipeIdFromKey };
