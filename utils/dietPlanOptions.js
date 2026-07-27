// Builds the per-servingTime recipe options pool shown in the dietician
// app's meal-selection screens (both the pre-finalize "review the AI's
// draft" screen and the post-finalize "adjust an already-finalized week"
// screen) - each servingTime slot lists every eligible recipe, flagged
// isSelected against whatever the plan/week already has chosen for that
// slot, so the dietician can pick additional items (not just swap the one
// the AI/plan picked).
//
// A recipe is eligible for a servingTime slot if either:
//   - its own stored `servingTime` matches exactly (the normal case), or
//   - it's tagged 'side' or 'salad' AND the slot is Lunch, Dinner, or
//     Evening Snack - sides (chapati/bhakri/rice) and salads are cooked
//     once with a fixed servingTime:'Lunch' (see scripts/add-side-dish-
//     recipes.js / add-salad-recipes.js) but in real usage accompany both
//     lunch and dinner (and occasionally an evening snack) just as
//     naturally - confirmed against Dr. Tejasvini's own source diet plans,
//     where a single Dinner routinely includes a bhakri *and* a chapati
//     *and* a salad alongside the main dish.
// This is purely a query-time broadening for these options-building call
// sites - it does not change any recipe's stored `servingTime`, so every
// other consumer (getServingTimeSummary's per-slot counts, the AI
// generation pool, etc.) is unaffected.
//
// Supplements get the same query-time-only treatment via a dedicated
// pseudo-slot, 'Supplements' - appended to the response (positioned by the
// frontend next to Night Drink) but NOT part of REQUIRED_SERVING_TIMES, so
// it's invisible to the AI-generation schema/prompt and finalize-week
// normalization; the dietician only ever browses/selects supplements
// manually here. A supplement selected from this pseudo-slot still
// persists under its own real servingTime (e.g. "Night Drink"), never
// under the literal string "Supplements" - see _recipeFromOptionModel in
// patients_controller.dart.

const { DAY_GROUPS, mealMatchesDayGroup } = require('./dayGroups');

const REQUIRED_SERVING_TIMES = [
  'Morning Drink',
  'Breakfast',
  'Brunch',
  'Lunch',
  'Evening Snack',
  'Dinner',
  'Night Drink',
];

const SUPPLEMENTS_PSEUDO_SLOT = 'Supplements';

const SIDE_SALAD_ELIGIBLE_SLOTS = new Set(['Lunch', 'Dinner', 'Evening Snack']);

/**
 * Fetches the dietician's full recipe pool once - the raw material for
 * buildServingTimeOptionsFromDocs. Split out from the old single
 * buildServingTimeOptions so a caller building options for multiple
 * day-groups (see dayGroups.js) can fetch this ONE time and reuse it,
 * instead of repeating the same DB query per day-group.
 */
async function fetchRecipePoolForOptions({ Recipe, dieticianId }) {
  return Recipe.find({ dieticianId })
    .select('name servingTime nutrition supplementFacts image ingredients servingSize secondaryComponent components tags category _id')
    .lean();
}

/**
 * @param recipeDocs  the dietician's full recipe pool, from fetchRecipePoolForOptions.
 * @param selectedByServingTime  { [servingTime]: Set<recipeId> } - the
 *   plan's currently-chosen recipe(s) for each slot, used to set
 *   `isSelected`. A slot can hold multiple selected recipes (e.g. a main
 *   dish plus a separately-selected chapati/salad), each its own
 *   dailyMeals entry sharing the same servingTime.
 * @param selectedServingsByServingTime  { [servingTime]: { [recipeId]: servings } } -
 *   optional, the servings value already persisted for each of that slot's
 *   selected recipes (see cleanSelectedMeals) - included on the response so
 *   re-opening a week shows what was actually set instead of resetting to 1.
 * @param selectedSecondaryServingsByServingTime  same shape, for recipes
 *   with a secondaryComponent (e.g. "Banana with Roasted Chana and Seeds" -
 *   servingSize is the banana, secondaryComponent is the seeds mix-in, each
 *   independently adjustable - see cleanSelectedMeals' secondaryServings).
 * @param selectedComponentServingsByServingTime  { [servingTime]: { [recipeId]: number[] } } -
 *   generalizes the two params above to however many components a recipe
 *   has (see models/Recipe.js's `components`) - index N is components[N]'s
 *   selected quantity. See cleanSelectedMeals' componentServings.
 * @param nextWeekRecipeIds  Set<string> - optional, tags a recipe with
 *   `nextWeekTag` if it's already selected for the following week.
 */
/**
 * Buckets a flat recipe-doc array by eligible servingTime slot - a recipe
 * is eligible for a slot if either its own stored `servingTime` matches, or
 * it's tagged 'side'/'salad' and the slot is in SIDE_SALAD_ELIGIBLE_SLOTS,
 * or (Supplements pseudo-slot) its category is 'Supplements'. Pure function
 * of recipeDocs alone - no selection state - so it's reusable by both the
 * dietician app's options-building (via buildServingTimeOptionsFromDocs
 * below) and the AI-generation candidate pool (dietPlanController.js),
 * without duplicating this bucketing logic in two places.
 */
function buildRecipesByServingTimeMap(recipeDocs) {
  const recipesByServingTime = {};
  recipeDocs.forEach((recipe) => {
    const isSupplement = recipe.category === 'Supplements';
    const ownSlot = recipe.servingTime || 'Other';

    if (!recipesByServingTime[ownSlot]) recipesByServingTime[ownSlot] = [];
    recipesByServingTime[ownSlot].push(recipe);

    const isSideOrSalad = Array.isArray(recipe.tags) && recipe.tags.some((t) => t === 'side' || t === 'salad');
    if (isSideOrSalad) {
      SIDE_SALAD_ELIGIBLE_SLOTS.forEach((slot) => {
        if (slot === ownSlot) return; // already added above, don't duplicate
        if (!recipesByServingTime[slot]) recipesByServingTime[slot] = [];
        recipesByServingTime[slot].push(recipe);
      });
    }

    if (isSupplement) {
      if (!recipesByServingTime[SUPPLEMENTS_PSEUDO_SLOT]) recipesByServingTime[SUPPLEMENTS_PSEUDO_SLOT] = [];
      recipesByServingTime[SUPPLEMENTS_PSEUDO_SLOT].push(recipe);
    }
  });
  return recipesByServingTime;
}

function buildServingTimeOptionsFromDocs({
  recipeDocs,
  selectedByServingTime = {},
  selectedServingsByServingTime = {},
  selectedSecondaryServingsByServingTime = {},
  selectedComponentServingsByServingTime = {},
  nextWeekRecipeIds = new Set(),
  currentWeekNumber = null,
}) {
  // Supplements are a dedicated pseudo-slot (see header comment) rather
  // than a *real* meal-slot option alongside real food (a Multivitamin
  // tablet competing with Poha for "Breakfast") - fetch them all (not just
  // already-selected ones, unlike before) so the Supplements pseudo-slot
  // has something to show.
  const selectedRecipeIdSet = new Set(
    Object.values(selectedByServingTime).flatMap((idSet) => [...idSet])
  );

  const recipesByServingTime = buildRecipesByServingTimeMap(recipeDocs);
  // UI-only: hide a not-yet-selected supplement from its own real slot's
  // browsable list, so it doesn't clutter e.g. "Breakfast" - one that's
  // already selected (e.g. AI-picked "Triphala Night Drink") still shows
  // under its real slot too, flagged isSelected, so Total Budget reflects
  // what was actually generated. This selection-awareness is a UI-only
  // concern, kept out of buildRecipesByServingTimeMap so that function stays
  // a pure function of recipeDocs alone.
  Object.keys(recipesByServingTime).forEach((slot) => {
    if (slot === SUPPLEMENTS_PSEUDO_SLOT) return;
    recipesByServingTime[slot] = recipesByServingTime[slot].filter(
      (r) => r.category !== 'Supplements' || selectedRecipeIdSet.has(r._id.toString())
    );
  });

  const servingTimes = [...REQUIRED_SERVING_TIMES, SUPPLEMENTS_PSEUDO_SLOT].map((servingTime) => {
    const isSupplementsPseudoSlot = servingTime === SUPPLEMENTS_PSEUDO_SLOT;
    // Supplements persist under their own real servingTime (not the
    // literal string "Supplements"), so isSelected/servings for this
    // pseudo-slot must look across every real slot's selections instead of
    // a (permanently empty) selectedByServingTime['Supplements'].
    const selectedIdsForSlot = isSupplementsPseudoSlot
      ? selectedRecipeIdSet
      : selectedByServingTime[servingTime] || new Set();
    const recipesForTime = (recipesByServingTime[servingTime] || []).map((recipe) => {
      const id = recipe._id.toString();
      const isSelected = selectedIdsForSlot.has(id);
      const servingsLookupSlot = isSupplementsPseudoSlot ? recipe.servingTime || servingTime : servingTime;
      const selectedServingsForSlot = selectedServingsByServingTime[servingsLookupSlot] || {};
      const selectedSecondaryServingsForSlot = selectedSecondaryServingsByServingTime[servingsLookupSlot] || {};
      const selectedComponentServingsForSlot = selectedComponentServingsByServingTime[servingsLookupSlot] || {};
      return {
        id,
        name: recipe.name || null,
        image: recipe.image || null,
        nutrition: recipe.nutrition || null,
        supplementFacts: recipe.supplementFacts || null,
        secondaryComponent: recipe.secondaryComponent || null,
        // See models/Recipe.js's `components` doc comment - the dietician
        // app should prefer this over servingSize/secondaryComponent above
        // once migrated; both are sent during the transition.
        components: Array.isArray(recipe.components) && recipe.components.length > 0
          ? recipe.components
          : null,
        servingTime: recipe.servingTime || servingTime,
        servingSize: recipe.servingSize || null,
        // 'supplement' is synthesized here (not a real stored tag) from
        // category so the dietician app can identify it regardless of
        // which tab (its own real slot or the Supplements pseudo-slot) it
        // was toggled from - see patients_controller.dart's
        // toggleMealSelection, which treats a supplement's selection as a
        // whole-week decision (same across all 4 day-groups), not a
        // per-day-group one.
        tags: recipe.category === 'Supplements' ? [...(recipe.tags || []), 'supplement'] : recipe.tags || [],
        isSelected,
        servings: isSelected ? selectedServingsForSlot[id] || 1 : 1,
        secondaryServings: isSelected
          ? selectedSecondaryServingsForSlot[id] || recipe.secondaryComponent?.quantity || 1
          : recipe.secondaryComponent?.quantity || 1,
        // Generalizes servings/secondaryServings above to every component
        // (see models/Recipe.js's `components`) - index N is
        // components[N]'s selected quantity. Unlike servings/
        // secondaryServings (which default to a sentinel of 1 to mean "not
        // explicitly set"), this is null unless the dietician actually
        // persisted explicit per-component quantities for this meal - a
        // real base quantity (e.g. "1 nos") is otherwise indistinguishable
        // from the sentinel. The dietician app falls back to the
        // servings/secondaryServings sentinel convention (components 0/1
        // only) when this is null - see patients_controller.dart's
        // _applyDraftOptionsForWeek.
        componentServings:
          isSelected && selectedComponentServingsForSlot[id]
            ? selectedComponentServingsForSlot[id]
            : null,
        nextWeekTag:
          currentWeekNumber !== null && currentWeekNumber < 4 && nextWeekRecipeIds.has(id)
            ? `Week ${currentWeekNumber + 1}`
            : null,
      };
    });

    return {
      // Kept for response-shape compatibility (unused by the dietician
      // app - isSelected on each recipe is the real signal now that a
      // slot can hold multiple selections); just the first selected id.
      servingTime,
      selectedRecipeId: [...selectedIdsForSlot][0] || null,
      recipes: recipesForTime,
    };
  });

  return servingTimes;
}

/**
 * Builds servingTime options for all 4 day-groups at once (see dayGroups.js)
 * from a single already-fetched recipe pool - the shared logic behind both
 * getDraftWeekOptions and getFinalizedWeekDetails. A meal with no dayGroup
 * (pre-migration data) matches every group, so old plans still show their
 * full unfiltered selection under any group.
 *
 * @param recipeDocs  the dietician's full recipe pool, from fetchRecipePoolForOptions.
 * @param dailyMeals  the week's full dailyMeals array (all 4 day-groups mixed).
 * @param nextWeekDailyMeals  optional, for nextWeekTag - kept flat (not
 *   day-group-scoped) across all of next week's entries, same simplification
 *   the single-day-group version already made.
 */
function buildDayGroupsOptions({
  recipeDocs,
  dailyMeals = [],
  nextWeekDailyMeals = [],
  currentWeekNumber = null,
}) {
  const nextWeekRecipeIds = new Set(
    nextWeekDailyMeals.filter((m) => m?.recipeId).map((m) => m.recipeId.toString())
  );

  return DAY_GROUPS.map((dayGroup) => {
    const mealsForGroup = dailyMeals.filter((m) => mealMatchesDayGroup(m, dayGroup));

    const selectedByServingTime = {};
    const selectedServingsByServingTime = {};
    const selectedSecondaryServingsByServingTime = {};
    const selectedComponentServingsByServingTime = {};
    mealsForGroup.forEach((meal) => {
      if (meal?.servingTime && meal?.recipeId) {
        const recipeId = meal.recipeId.toString();
        if (!selectedByServingTime[meal.servingTime]) {
          selectedByServingTime[meal.servingTime] = new Set();
          selectedServingsByServingTime[meal.servingTime] = {};
          selectedSecondaryServingsByServingTime[meal.servingTime] = {};
          selectedComponentServingsByServingTime[meal.servingTime] = {};
        }
        selectedByServingTime[meal.servingTime].add(recipeId);
        selectedServingsByServingTime[meal.servingTime][recipeId] =
          typeof meal.servings === 'number' && meal.servings > 0 ? meal.servings : 1;
        if (typeof meal.secondaryServings === 'number' && meal.secondaryServings > 0) {
          selectedSecondaryServingsByServingTime[meal.servingTime][recipeId] = meal.secondaryServings;
        }
        if (Array.isArray(meal.componentServings) && meal.componentServings.length > 0) {
          selectedComponentServingsByServingTime[meal.servingTime][recipeId] = meal.componentServings;
        }
      }
    });

    const servingTimes = buildServingTimeOptionsFromDocs({
      recipeDocs,
      selectedByServingTime,
      selectedServingsByServingTime,
      selectedSecondaryServingsByServingTime,
      selectedComponentServingsByServingTime,
      nextWeekRecipeIds,
      currentWeekNumber,
    });

    return { dayGroup, servingTimes };
  });
}

/**
 * Thin fetch+build wrapper over buildServingTimeOptionsFromDocs, kept for
 * any single-day-group caller - fetches the recipe pool and builds options
 * in one call, same signature/behavior as the original buildServingTimeOptions.
 */
async function buildServingTimeOptions({ Recipe, dieticianId, ...rest }) {
  const recipeDocs = await fetchRecipePoolForOptions({ Recipe, dieticianId });
  return buildServingTimeOptionsFromDocs({ recipeDocs, ...rest });
}

module.exports = {
  buildServingTimeOptions,
  buildServingTimeOptionsFromDocs,
  buildRecipesByServingTimeMap,
  buildDayGroupsOptions,
  fetchRecipePoolForOptions,
  REQUIRED_SERVING_TIMES,
  SIDE_SALAD_ELIGIBLE_SLOTS,
  SUPPLEMENTS_PSEUDO_SLOT,
};
