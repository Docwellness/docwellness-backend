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

const NUTRITION_FIELDS = ['calories', 'protein', 'carbs', 'fats', 'fiber'];

// Converts one ingredient line's {rawQuantity, unit} into a grams-equivalent
// for nutrition math, using whatever conversion data the FoodItem carries.
// Returns null (never a guessed number) when no real conversion is known -
// per the v4.0 plan's "never silently approximate" rule, an unconvertible
// unit makes that ingredient's contribution unresolved, same as a missing
// nutritionPer100g does.
function resolveGramsForIngredient(foodItem, rawQuantity, unit) {
  if (unit === 'g') return rawQuantity;
  if (foodItem?.unitConversions && typeof foodItem.unitConversions[unit] === 'number') {
    return rawQuantity * foodItem.unitConversions[unit];
  }
  if (unit === 'ml' && typeof foodItem?.density === 'number') {
    return rawQuantity * foodItem.density;
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
 */
async function createCustomVersion(originalVersionId, updatedIngredients, { createdBy = null } = {}) {
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

  const foodItemIds = updatedIngredients.map((ingredient) => ingredient.foodItemId);
  const foodItems = await FoodItem.find({ _id: { $in: foodItemIds } });
  const foodItemsById = new Map(foodItems.map((foodItem) => [String(foodItem._id), foodItem]));

  const { nutritionPerServing, hasUnresolvedIngredients, unresolvedIngredientNames } = computeNutritionFromIngredients(
    updatedIngredients,
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

  return RecipeVersion.create({
    name: original.name,
    parentRecipeId: original.parentRecipeId,
    versionNumber: nextVersionNumber,
    baseYield: original.baseYield,
    cookingMethod: original.cookingMethod,
    moistureChangeFactor: original.moistureChangeFactor,
    ingredients: updatedIngredients,
    steps: original.steps,
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

module.exports = {
  computeNutritionFromIngredients,
  resolveGramsForIngredient,
  syncV1FromRecipe,
  createCustomVersion,
};
