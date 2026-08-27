/**
 * v4.0's core new engine: turns a Recipe's (name-matched) ingredient list
 * into an immutable RecipeVersion with real per-ingredient nutrition, and
 * creates new versions when a dietician edits ingredient quantities for one
 * specific patient's plan.
 *
 * Two entry points:
 *   - syncV1FromRecipe(recipe): called from Recipe.js's post-save hook
 *     whenever a recipe's ingredients/components/instructions/nutrition
 *     change. Keeps that Recipe's V1 RecipeVersion up to date - UNLESS a
 *     PlanItem already references the current V1, in which case it bumps to
 *     a new version instead of mutating what's already prescribed (see the
 *     freeze-semantics comment below - this is the load-bearing invariant
 *     that makes "editing a Recipe never silently changes an already-
 *     prescribed plan" true).
 *   - createCustomVersion(originalVersionId, updatedIngredients, opts):
 *     a dietician manually editing ingredient quantities in the Step 3
 *     Ingredient Editor (or services/ingredientAutoBalanceService.js's
 *     auto-balance, which computes updatedIngredients itself and calls
 *     this same function) - ALWAYS inserts a brand-new document, never
 *     mutates the original. This is what "editing an ingredient does not
 *     mutate V1" actually means in code.
 *
 * Neither function ever calls .save() on an EXISTING RecipeVersion document
 * to change its ingredients/nutritionPerServing - immutability here is a
 * code-level discipline, not a schema-level lock.
 */

const RecipeVersion = require('../models/RecipeVersion');
const FoodItem = require('../models/FoodItem');
const PlanItem = require('../models/PlanItem');
const { normalize } = require('../utils/ingredientLibrary');
const { rewriteRecipeStepsForIngredients } = require('../utils/openaiClient');
const { applyCoreIngredientHeuristic, hasCoreIngredient } = require('../utils/coreIngredientHeuristic');

const NUTRITION_FIELDS = ['calories', 'protein', 'carbs', 'fats', 'fiber'];

// Universal cooking-measurement constants (NOT ingredient-specific data,
// unlike FoodItem.unitConversions) - a teaspoon/tablespoon/cup is always
// the same volume regardless of what's in it. Standard US cooking
// conventions, same figures already implicit in this catalog's own
// FoodItem.unitConversions entries (e.g. Oil: tbsp:14 / density 0.933
// implies ~15ml/tbsp; Ghee: tbsp:13.5 similarly implies ~15ml/tbsp).
const STANDARD_VOLUME_ML = { ml: 1, tsp: 5, tbsp: 15, cup: 240 };

// Converts one ingredient line's {rawQuantity, unit} into a grams-equivalent
// for nutrition math, using whatever conversion data the FoodItem carries.
// Returns null (never a guessed number) when no real conversion is known -
// per the v4.0 plan's "never silently approximate" rule, an unconvertible
// unit makes that ingredient's contribution unresolved, same as a missing
// nutritionPer100g does.
//
// Resolution order: (1) an ingredient-specific unitConversions[unit] entry,
// when the FoodItem has one - always most accurate, since it can reflect a
// real per-piece/per-egg/etc. weight that a generic formula never could;
// (2) for any of the standard volume units (ml/tsp/tbsp/cup) with no
// explicit override, rawQuantity * STANDARD_VOLUME_ML[unit] * density -
// this is what lets switching an ingredient's unit (e.g. Lemon from
// 'piece' to 'tsp') keep resolving instead of silently going unresolvable
// just because nobody hand-authored a tsp-specific entry for it. Still
// returns null, never a guessed number, when density itself isn't known -
// this only ever bridges volume<->mass for an ingredient whose real
// density is on file, it never invents one.
function resolveGramsForIngredient(foodItem, rawQuantity, unit) {
  if (unit === 'g') return rawQuantity;
  if (foodItem?.unitConversions && typeof foodItem.unitConversions[unit] === 'number') {
    return rawQuantity * foodItem.unitConversions[unit];
  }
  if (typeof STANDARD_VOLUME_ML[unit] === 'number' && typeof foodItem?.density === 'number') {
    return rawQuantity * STANDARD_VOLUME_ML[unit] * foodItem.density;
  }
  return null;
}

/**
 * Sums nutritionPerServing across a list of {foodItemId, rawQuantity, unit}
 * ingredient lines, given a Map of foodItemId(string) -> FoodItem document
 * already fetched by the caller. Shared by syncV1FromRecipe and
 * createCustomVersion so V1 and V2+ compute nutrition identically - avoids
 * the two ever drifting apart.
 *
 * Any ingredient that can't be fully resolved (no FoodItem, incomplete
 * nutritionPer100g, or no known unit conversion) is excluded from the sum
 * and named in unresolvedIngredientNames - nutritionPerServing is computed
 * from only the resolved ingredients, never treated as 0 or backfilled from
 * elsewhere.
 */
function computeNutritionFromIngredients(ingredients, foodItemsById) {
  const totals = { calories: 0, protein: 0, carbs: 0, fats: 0, fiber: 0 };
  const unresolvedIngredientNames = [];
  let anyResolved = false;

  for (const ingredient of ingredients || []) {
    const foodItem = foodItemsById.get(String(ingredient.foodItemId));
    const per100g = foodItem?.nutritionPer100g;
    const hasAllMacros = !!per100g && NUTRITION_FIELDS.every((field) => typeof per100g[field] === 'number');
    const grams = foodItem ? resolveGramsForIngredient(foodItem, ingredient.rawQuantity, ingredient.unit) : null;

    if (!foodItem || !hasAllMacros || grams === null) {
      unresolvedIngredientNames.push(foodItem?.name || String(ingredient.foodItemId || 'unknown ingredient'));
      continue;
    }

    anyResolved = true;
    for (const field of NUTRITION_FIELDS) {
      totals[field] += (grams / 100) * per100g[field];
    }
  }

  const nutritionPerServing = {};
  for (const field of NUTRITION_FIELDS) {
    nutritionPerServing[field] = anyResolved ? Math.round(totals[field] * 100) / 100 : null;
  }

  return {
    nutritionPerServing,
    hasUnresolvedIngredients: unresolvedIngredientNames.length > 0,
    unresolvedIngredientNames,
  };
}

/**
 * Auto-generates/refreshes a Recipe's V1 RecipeVersion. Fire-and-forget from
 * the caller's perspective - never throws, logs and returns null on failure,
 * since a recipe save must never fail because of this bookkeeping (matches
 * Recipe.js's own pre-save hook's "never throws" discipline).
 */
async function syncV1FromRecipe(recipe) {
  try {
    if (!recipe?.ingredients?.length) return null;

    const normalizedNames = recipe.ingredients.map((ingredient) => normalize(ingredient.name));
    const foodItems = await FoodItem.find({ normalizedName: { $in: normalizedNames } });
    const foodItemsByNormalizedName = new Map(foodItems.map((foodItem) => [foodItem.normalizedName, foodItem]));
    const foodItemsById = new Map(foodItems.map((foodItem) => [String(foodItem._id), foodItem]));

    const versionIngredients = recipe.ingredients
      .map((ingredient) => {
        const foodItem = foodItemsByNormalizedName.get(normalize(ingredient.name));
        return foodItem
          ? {
              foodItemId: foodItem._id,
              rawQuantity: ingredient.quantity,
              unit: ingredient.unit,
              preparation: null,
              // recipe-core-ingredient-scaling: carry the master Recipe's
              // per-ingredient role forward - see models/RecipeVersion.js's
              // own comment on this field.
              role: ingredient.role,
            }
          : null;
      })
      .filter(Boolean);

    const unmatchedNames = recipe.ingredients
      .filter((ingredient) => !foodItemsByNormalizedName.has(normalize(ingredient.name)))
      .map((ingredient) => ingredient.name);

    const { nutritionPerServing, unresolvedIngredientNames: unresolvedFromNutrition } = computeNutritionFromIngredients(
      versionIngredients,
      foodItemsById
    );
    const allUnresolvedNames = Array.from(new Set([...unmatchedNames, ...unresolvedFromNutrition]));

    // Freeze semantics: only upsert V1 in place if nothing has prescribed it
    // to a real patient yet. Once a PlanItem references it, a later Recipe
    // edit must produce a NEW version instead of silently rewriting food
    // that's already been prescribed.
    const existingV1 = await RecipeVersion.findOne({ parentRecipeId: recipe._id, versionNumber: 1 });
    let targetVersionNumber = 1;
    if (existingV1) {
      const referenced = await PlanItem.exists({ recipeVersionId: existingV1._id });
      if (referenced) {
        const latest = await RecipeVersion.findOne({ parentRecipeId: recipe._id }).sort({ versionNumber: -1 });
        targetVersionNumber = (latest?.versionNumber || existingV1.versionNumber) + 1;
      }
    }

    const payload = {
      name: recipe.name,
      parentRecipeId: recipe._id,
      versionNumber: targetVersionNumber,
      baseYield: recipe.baseYield,
      cookingMethod: recipe.cookingMethod,
      moistureChangeFactor: recipe.moistureChangeFactor,
      ingredients: versionIngredients,
      steps: recipe.instructions || [],
      components: recipe.components || [],
      nutritionPerServing,
      hasUnresolvedIngredients: allUnresolvedNames.length > 0,
      unresolvedIngredientNames: allUnresolvedNames,
      mealSlotSuitability: recipe.mealSlotSuitability,
      dietaryTags: recipe.dietaryTags,
      allergens: recipe.allergens,
      status: 'Active',
      createdBy: null,
    };

    // Atomic upsert on the {parentRecipeId, versionNumber} unique index,
    // not a check-then-insert - the post-save hook this function is called
    // from can legitimately fire concurrently with another call for the
    // same recipe (e.g. a script explicitly re-syncing while a hook from an
    // earlier save is still in flight), and a plain findOne-then-create
    // would race under that condition.
    try {
      return await RecipeVersion.findOneAndUpdate(
        { parentRecipeId: recipe._id, versionNumber: targetVersionNumber },
        { $set: payload },
        { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
      );
    } catch (err) {
      // MongoDB can still surface E11000 on a losing side of a concurrent
      // upsert race even with findOneAndUpdate - the winning side's document
      // is what should be returned in that case, not treated as a failure.
      if (err.code === 11000) {
        return RecipeVersion.findOne({ parentRecipeId: recipe._id, versionNumber: targetVersionNumber });
      }
      throw err;
    }
  } catch (err) {
    console.error(`recipeVersioningService.syncV1FromRecipe failed for recipe ${recipe?._id} (non-blocking):`, err.message);
    return null;
  }
}

/**
 * Creates a brand-new RecipeVersion with dietician-edited ingredient
 * quantities, pointed at by the caller afterward (repointing a PlanItem is
 * the caller's job, e.g. the create-custom-version endpoint handler - this
 * function only creates the document and returns it). Never mutates
 * `originalVersionId`'s document.
 *
 * `regenerateSteps` (default false) rewrites the new version's step text via
 * utils/openaiClient.js's rewriteRecipeStepsForIngredients so quantity
 * mentions in the prose (e.g. "1 tsp (5g) cumin") stay honest with the
 * edited ingredients - without it, `steps` is copied verbatim from
 * `original` forever, which is what silently left every past version's
 * cooking-step text describing V1's quantities. Deliberately opt-in, not
 * the default: the caller here is shared with
 * services/ingredientAutoBalanceService.js's autoBalanceWeek, which runs
 * automatically and frequently (every Refine Portions entry) and must stay
 * fast/deterministic/offline - only controllers/dietician/planItemController.js's
 * createCustomRecipeVersion (an explicit, infrequent dietician "Save" action)
 * passes true.
 */
async function createCustomVersion(originalVersionId, updatedIngredients, { createdBy = null, regenerateSteps = false } = {}) {
  const original = await RecipeVersion.findById(originalVersionId);
  if (!original) {
    throw new Error(`RecipeVersion not found: ${originalVersionId}`);
  }
  if (original.status !== 'Active') {
    throw new Error(`RecipeVersion ${originalVersionId} is not Active (status: ${original.status})`);
  }
  if (!Array.isArray(updatedIngredients) || updatedIngredients.length === 0) {
    throw new Error('updatedIngredients must be a non-empty array');
  }

  const latest = await RecipeVersion.findOne({ parentRecipeId: original.parentRecipeId }).sort({ versionNumber: -1 });
  const nextVersionNumber = (latest?.versionNumber || original.versionNumber) + 1;

  // Also fetch FoodItems for original's own ingredients (not just the
  // submitted list) - needed to resolve a core ingredient's PREVIOUS grams
  // even in the edge case where the dietician's submission drops it
  // entirely (see the core-group recompute below, which treats a missing
  // core entry as 0 new grams rather than bailing out).
  const foodItemIds = [
    ...updatedIngredients.map((ingredient) => ingredient.foodItemId),
    ...original.ingredients.map((ingredient) => ingredient.foodItemId),
  ];
  const foodItems = await FoodItem.find({ _id: { $in: foodItemIds } });
  const foodItemsById = new Map(foodItems.map((foodItem) => [String(foodItem._id), foodItem]));

  // recipe-core-ingredient-scaling: when the core ingredient group's total
  // weight (grams, via resolveGramsForIngredient) changed from `original`
  // to what was submitted, every `role: 'sub'` ingredient's quantity is
  // recomputed in that same proportion - overriding whatever was submitted
  // for it - rather than trusting the client's value at face value. See
  // openspec/changes/recipe-core-ingredient-scaling/design.md's Decisions
  // for the full rationale (this mirrors the existing componentScaleRatio
  // pattern just below, but keyed off the core group's weight instead of
  // the whole recipe's calorie change).
  //
  // "Inert" (no recompute) whenever: there's no role:'core' ingredient at
  // all (legacy, not-yet-migrated recipe), a core ingredient's grams can't
  // be resolved on either side (unknown unit conversion), or the total
  // simply didn't change beyond floating-point noise - in every one of
  // those cases `updatedIngredients` is used exactly as submitted, byte-
  // for-byte identical to this function's pre-existing behavior.
  const originalCoreIngredients = original.ingredients.filter((ingredient) => ingredient.role === 'core');
  const updatedIngredientsByFoodItemId = new Map(
    updatedIngredients.map((ingredient) => [String(ingredient.foodItemId), ingredient])
  );

  let coreWeightRatio = null;
  if (originalCoreIngredients.length > 0) {
    let previousCoreGrams = 0;
    let newCoreGrams = 0;
    let resolvable = true;

    for (const coreIngredient of originalCoreIngredients) {
      const foodItem = foodItemsById.get(String(coreIngredient.foodItemId));
      const previousGrams = resolveGramsForIngredient(foodItem, coreIngredient.rawQuantity, coreIngredient.unit);
      if (previousGrams === null) {
        resolvable = false;
        break;
      }
      previousCoreGrams += previousGrams;

      // A core ingredient the dietician's submission dropped entirely
      // contributes 0 new grams (a real, resolvable data point - the group
      // genuinely shrank), not an "unresolvable" bail-out.
      const submitted = updatedIngredientsByFoodItemId.get(String(coreIngredient.foodItemId));
      if (!submitted) continue;
      const newGrams = resolveGramsForIngredient(foodItem, submitted.rawQuantity, submitted.unit);
      if (newGrams === null) {
        resolvable = false;
        break;
      }
      newCoreGrams += newGrams;
    }

    if (resolvable && previousCoreGrams > 0) {
      const ratio = newCoreGrams / previousCoreGrams;
      // Skip a no-op rewrite for a ratio that's 1 up to floating-point noise.
      if (Math.abs(ratio - 1) > 1e-9) coreWeightRatio = ratio;
    }
  }

  const originalByFoodItemId = new Map(
    original.ingredients.map((ingredient) => [String(ingredient.foodItemId), ingredient])
  );
  // Every saved ingredient carries `role` forward from `original` (matched
  // by foodItemId) regardless of whether a recompute fired - the client
  // never submits `role` itself (see this function's own doc comment on
  // updatedIngredients' shape), so it has to come from here or every V2+
  // would silently lose it. An ingredient with no match in `original` (the
  // dietician added a brand-new one via this edit) defaults to 'sub',
  // matching this feature's schema default and the same "never silently
  // promote to the more consequential state" convention used elsewhere.
  const recomputedIngredients = updatedIngredients.map((ingredient) => {
    const originalMatch = originalByFoodItemId.get(String(ingredient.foodItemId));
    const role = originalMatch?.role === 'core' ? 'core' : 'sub';
    if (coreWeightRatio === null || !originalMatch || originalMatch.role !== 'sub') {
      return { ...ingredient, role };
    }
    return {
      ...ingredient,
      role,
      rawQuantity: Math.round(originalMatch.rawQuantity * coreWeightRatio * 100) / 100,
    };
  });

  const { nutritionPerServing, hasUnresolvedIngredients, unresolvedIngredientNames } = computeNutritionFromIngredients(
    recomputedIngredients,
    foodItemsById
  );

  // Real-world serving quantity (e.g. "2 pieces") scales with the recipe,
  // same proportion as the calorie change - if editing ingredients doubled
  // the calories, the dish is now roughly twice the real-world serving too.
  // Falls back to an unscaled copy (ratio 1) when either side's calories
  // aren't resolvable - a component quantity should never be computed from
  // an unknown baseline.
  const originalCalories = original.nutritionPerServing?.calories;
  const newCalories = nutritionPerServing?.calories;
  const componentScaleRatio = originalCalories > 0 && newCalories > 0 ? newCalories / originalCalories : 1;
  const scaledComponents = (original.components || []).map((component) => ({
    label: component.label,
    quantity: Math.round(component.quantity * componentScaleRatio * 100) / 100,
    unit: component.unit,
  }));

  let steps = original.steps;
  if (regenerateSteps && Array.isArray(original.steps) && original.steps.length > 0) {
    const namedIngredients = recomputedIngredients.map((ingredient) => {
      const foodItem = foodItemsById.get(String(ingredient.foodItemId));
      return {
        name: foodItem?.name || 'Unknown ingredient',
        quantity: ingredient.rawQuantity,
        unit: ingredient.unit,
        ...(ingredient.preparation ? { preparation: ingredient.preparation } : {}),
      };
    });
    steps = await rewriteRecipeStepsForIngredients({ name: original.name, ingredients: namedIngredients, steps: original.steps });
  }

  return RecipeVersion.create({
    name: original.name,
    parentRecipeId: original.parentRecipeId,
    versionNumber: nextVersionNumber,
    baseYield: original.baseYield,
    cookingMethod: original.cookingMethod,
    moistureChangeFactor: original.moistureChangeFactor,
    ingredients: recomputedIngredients,
    steps,
    components: scaledComponents,
    nutritionPerServing,
    hasUnresolvedIngredients,
    unresolvedIngredientNames,
    mealSlotSuitability: original.mealSlotSuitability,
    dietaryTags: original.dietaryTags,
    allergens: original.allergens,
    status: 'Active',
    createdBy,
  });
}

/**
 * Creates a brand-new RecipeVersion for `originalVersionId`'s parent recipe
 * from a full free-text recipe snapshot (name-based ingredients, e.g. the
 * AI-regenerated preview "Update AI Inputs" produces) rather than
 * already-resolved {foodItemId, rawQuantity, unit} lines - resolves each
 * ingredient's name to a FoodItem the same way syncV1FromRecipe does for a
 * saved Recipe document, without requiring (or mutating) any Recipe document
 * at all. This is what lets a dietician apply an AI-regenerated recipe to
 * ONE plan item (controllers/dietician/planItemController.js's
 * updateItemRecipeVersion, this function's only caller) without overwriting
 * the shared catalog recipe every other patient/plan using it still points
 * at - PATCHing the Recipe document (recipe_details.dart's "Save Recipe")
 * would do that; this never touches it.
 */
async function createVersionFromSnapshot(originalVersionId, snapshot, { createdBy = null } = {}) {
  const original = await RecipeVersion.findById(originalVersionId);
  if (!original) {
    throw new Error(`RecipeVersion not found: ${originalVersionId}`);
  }
  if (original.status !== 'Active') {
    throw new Error(`RecipeVersion ${originalVersionId} is not Active (status: ${original.status})`);
  }
  const ingredients = snapshot?.ingredients;
  if (!Array.isArray(ingredients) || ingredients.length === 0) {
    throw new Error('snapshot.ingredients must be a non-empty array');
  }

  const normalizedNames = ingredients.map((ingredient) => normalize(ingredient.name));
  const foodItems = await FoodItem.find({ normalizedName: { $in: normalizedNames } });
  const foodItemsByNormalizedName = new Map(foodItems.map((foodItem) => [foodItem.normalizedName, foodItem]));
  const foodItemsById = new Map(foodItems.map((foodItem) => [String(foodItem._id), foodItem]));

  // recipe-core-ingredient-scaling: role is carried through from the
  // snapshot's own ingredients when present (generateRecipeWithAI already
  // assigns it - see updateRecipeFromEdits, this function's only caller's
  // caller), defaulting via the same deterministic heuristic used
  // everywhere else when it isn't. Applied on the snapshot's OWN ingredient
  // objects (which carry `category`, e.g. "Vegetable"/"Grain") rather than
  // on FoodItem records - FoodItem has no `category` field at all, that
  // concept only exists on the recipe-authoring side. Deliberately NOT
  // running createCustomVersion's core-group aggregate-weight recompute
  // here - this snapshot is a FULL AI regeneration of every ingredient at
  // once (there's no "previous version's ingredient list" to compare a
  // core group's weight against; `ingredients` here isn't an incremental
  // edit to `original`, it replaces it entirely), so there's nothing
  // meaningful to recompute a ratio from.
  const roleCorrectedIngredients = hasCoreIngredient(ingredients)
    ? ingredients
    : applyCoreIngredientHeuristic(ingredients);

  const versionIngredients = roleCorrectedIngredients
    .map((ingredient) => {
      const foodItem = foodItemsByNormalizedName.get(normalize(ingredient.name));
      return foodItem
        ? {
            foodItemId: foodItem._id,
            rawQuantity: ingredient.quantity,
            unit: ingredient.unit,
            preparation: null,
            role: ingredient.role === 'core' ? 'core' : 'sub',
          }
        : null;
    })
    .filter(Boolean);

  if (versionIngredients.length === 0) {
    throw new Error("None of this recipe's ingredients matched a known food item");
  }

  const unmatchedNames = ingredients
    .filter((ingredient) => !foodItemsByNormalizedName.has(normalize(ingredient.name)))
    .map((ingredient) => ingredient.name);

  const { nutritionPerServing, unresolvedIngredientNames: unresolvedFromNutrition } = computeNutritionFromIngredients(
    versionIngredients,
    foodItemsById
  );
  const allUnresolvedNames = Array.from(new Set([...unmatchedNames, ...unresolvedFromNutrition]));

  const latest = await RecipeVersion.findOne({ parentRecipeId: original.parentRecipeId }).sort({ versionNumber: -1 });
  const nextVersionNumber = (latest?.versionNumber || original.versionNumber) + 1;

  return RecipeVersion.create({
    name: snapshot.name || original.name,
    parentRecipeId: original.parentRecipeId,
    versionNumber: nextVersionNumber,
    baseYield: original.baseYield,
    cookingMethod: original.cookingMethod,
    moistureChangeFactor: original.moistureChangeFactor,
    ingredients: versionIngredients,
    steps: Array.isArray(snapshot.cookingSteps) ? snapshot.cookingSteps : original.steps,
    components: Array.isArray(snapshot.components) && snapshot.components.length > 0 ? snapshot.components : original.components,
    nutritionPerServing,
    hasUnresolvedIngredients: allUnresolvedNames.length > 0,
    unresolvedIngredientNames: allUnresolvedNames,
    mealSlotSuitability: original.mealSlotSuitability,
    dietaryTags: original.dietaryTags,
    allergens: original.allergens,
    status: 'Active',
    createdBy,
  });
}

module.exports = {
  computeNutritionFromIngredients,
  resolveGramsForIngredient,
  syncV1FromRecipe,
  createCustomVersion,
  createVersionFromSnapshot,
};
