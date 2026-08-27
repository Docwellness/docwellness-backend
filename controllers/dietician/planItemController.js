/**
 * v4.0: Ingredient-Level Portioning + Recipe Versioning endpoints - a new
 * sibling to dietPlanController.js (already ~2700+ lines) rather than
 * growing that file further, matching the existing precedent of
 * dietController.js/dietPlanController.js/trackingController.js already
 * being separate files by concern.
 *
 * Every handler here only ever operates on a DietPlan whose
 * dataModel === 'plan-item' - a days-array plan gets a 400, not a silent
 * no-op, since both data models' routes now coexist on the same dietician
 * and calling the wrong one is a real bug to surface, not paper over.
 */

const mongoose = require('mongoose');
const { DietPlan, Recipe, RecipeVersion, FoodItem, DayPlan, MealSlotPlan, PlanItem, SupplementItem } = require('../../models');
const { REQUIRED_SERVING_TIMES } = require('../../utils/servingTimes');
const { COMPONENT_UNITS } = require('../../utils/recipeJsonSchema');
const { DAY_GROUPS } = require('../../utils/dayGroups');
const { generateMenu } = require('../../services/menuGenerationService');
const { createCustomVersion, resolveGramsForIngredient, createVersionFromSnapshot } = require('../../services/recipeVersioningService');
const { autoBalanceIngredients, autoBalanceDay, autoBalanceWeek } = require('../../services/ingredientAutoBalanceService');
const { validatePlanForActivation } = require('../../services/planActivationService');
const { swapToRecipe } = require('../../services/recipeVersionSwapService');

async function loadPlanItemDietPlan(req, res) {
  const { patientId, dietPlanId } = req.params;
  const dieticianId = req.user._id;
  if (!mongoose.Types.ObjectId.isValid(patientId) || !mongoose.Types.ObjectId.isValid(dietPlanId)) {
    res.status(400).json({ success: false, message: 'Invalid patient or diet plan id' });
    return null;
  }
  const dietPlan = await DietPlan.findOne({ _id: dietPlanId, patientId, dieticianId });
  if (!dietPlan) {
    res.status(404).json({ success: false, message: 'Diet plan not found for this patient' });
    return null;
  }
  if (dietPlan.dataModel !== 'plan-item') {
    res
      .status(400)
      .json({ success: false, message: 'This diet plan uses the legacy days-array model - use the /week-tweak, /swap, /supplements endpoints instead.' });
    return null;
  }
  return dietPlan;
}

/** Throws if planItemId doesn't belong to this dietPlan (via mealSlot -> dayPlan -> dietPlanId), preventing cross-plan mutation via a guessed id. */
async function loadOwnedPlanItem(dietPlan, planItemId) {
  const planItem = await PlanItem.findById(planItemId);
  if (!planItem) throw new Error('PlanItem not found');
  const mealSlot = await MealSlotPlan.findById(planItem.mealSlotId);
  if (!mealSlot) throw new Error('PlanItem not found');
  const dayPlan = await DayPlan.findById(mealSlot.dayPlanId);
  if (!dayPlan || String(dayPlan.dietPlanId) !== String(dietPlan._id)) {
    throw new Error('PlanItem not found');
  }
  return { planItem, mealSlot, dayPlan };
}

/** Throws if mealSlotId doesn't belong to this dietPlan - same ownership discipline as loadOwnedPlanItem. */
async function loadOwnedMealSlot(dietPlan, mealSlotId) {
  const mealSlot = await MealSlotPlan.findById(mealSlotId);
  if (!mealSlot) throw new Error('MealSlot not found');
  const dayPlan = await DayPlan.findById(mealSlot.dayPlanId);
  if (!dayPlan || String(dayPlan.dietPlanId) !== String(dietPlan._id)) {
    throw new Error('MealSlot not found');
  }
  return { mealSlot, dayPlan };
}

/**
 * @desc    Step 2: fill every slot for the given week(s) with a PlanItem
 *          pointing at a recipe's V1 RecipeVersion - no scaling, see
 *          services/menuGenerationService.js's header.
 * @route   POST /api/dietician/patients/:patientId/diet-plans/:dietPlanId/generate-menu
 * @access  Private (Dietician)
 */
exports.generateMenu = async (req, res, next) => {
  try {
    const dietPlan = await loadPlanItemDietPlan(req, res);
    if (!dietPlan) return;

    const weekNumbers = Array.isArray(req.body?.weekNumbers) && req.body.weekNumbers.length > 0 ? req.body.weekNumbers : [1, 2, 3, 4];
    if (!weekNumbers.every((w) => Number.isInteger(w) && w >= 1 && w <= 4)) {
      return res.status(400).json({ success: false, message: 'weekNumbers must be integers between 1 and 4' });
    }

    const allergies = dietPlan.targetProfile?.allergies || [];
    const totalCalories = dietPlan.calorieStrategy?.calorieBudget || null;
    const mealDistribution = dietPlan.targetProfile?.mealDistribution;

    const { createdPlanItemIds, unfillableSlots } = await generateMenu({
      dietPlanId: dietPlan._id,
      patientId: dietPlan.patientId,
      dieticianId: req.user._id,
      allergies,
      weekNumbers,
      restrictNonVegToDayGroups: !!req.body?.restrictNonVegToDayGroups,
      totalCalories,
      mealDistribution,
    });

    dietPlan.workflowStatus = 'menu_generated';
    await dietPlan.save();

    return res.status(200).json({
      success: true,
      data: { createdPlanItemCount: createdPlanItemIds.length, unfillableSlots, workflowStatus: dietPlan.workflowStatus },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Step 3: create a new RecipeVersion from dietician-edited
 *          ingredient quantities and repoint one PlanItem at it.
 * @route   POST /api/dietician/patients/:patientId/diet-plans/:dietPlanId/create-custom-version
 * @access  Private (Dietician)
 */
exports.createCustomRecipeVersion = async (req, res, next) => {
  try {
    const dietPlan = await loadPlanItemDietPlan(req, res);
    if (!dietPlan) return;

    const { planItemId, ingredients } = req.body || {};
    if (!mongoose.Types.ObjectId.isValid(planItemId)) {
      return res.status(400).json({ success: false, message: 'planItemId must be a valid id' });
    }
    if (!Array.isArray(ingredients) || ingredients.length === 0) {
      return res.status(400).json({ success: false, message: 'ingredients must be a non-empty array' });
    }

    const { planItem } = await loadOwnedPlanItem(dietPlan, planItemId);
    // regenerateSteps: true - this is the dietician's own explicit Save from
    // the Ingredient Editor, unlike ingredientAutoBalanceService.js's
    // automatic (and frequent) auto-balance, which never passes this - see
    // createCustomVersion's own doc comment.
    const newVersion = await createCustomVersion(planItem.recipeVersionId, ingredients, {
      createdBy: req.user._id,
      regenerateSteps: true,
    });

    planItem.recipeVersionId = newVersion._id;
    planItem.calculatedNutrition = newVersion.nutritionPerServing;
    await planItem.save();

    if (dietPlan.workflowStatus === 'menu_generated') {
      dietPlan.workflowStatus = 'portions_refined';
      await dietPlan.save();
    }

    return res.status(200).json({ success: true, data: { planItem, recipeVersion: newVersion } });
  } catch (error) {
    if (error.message === 'PlanItem not found' || error.message?.startsWith('RecipeVersion not found')) {
      return res.status(404).json({ success: false, message: error.message });
    }
    next(error);
  }
};

/**
 * @desc    Applies an AI-regenerated recipe snapshot ("Update AI Inputs" -
 *          free-text ingredients, not yet resolved to FoodItems) to ONE plan
 *          item only: creates a new RecipeVersion under the item's existing
 *          parentRecipeId and repoints just this PlanItem, mirroring
 *          createCustomRecipeVersion above but for AI-regenerated output
 *          rather than manually-edited, already-FoodItem-resolved ingredient
 *          lines. Never touches the shared Recipe document - unlike PATCHing
 *          the recipe (which would change it for every other patient/plan
 *          using it), this only changes what this one plan item points at.
 * @route   POST /api/dietician/patients/:patientId/diet-plans/:dietPlanId/update-item-recipe-version
 * @access  Private (Dietician)
 */
exports.updateItemRecipeVersion = async (req, res, next) => {
  try {
    const dietPlan = await loadPlanItemDietPlan(req, res);
    if (!dietPlan) return;

    const { planItemId, recipe } = req.body || {};
    if (!mongoose.Types.ObjectId.isValid(planItemId)) {
      return res.status(400).json({ success: false, message: 'planItemId must be a valid id' });
    }
    if (!recipe || !Array.isArray(recipe.ingredients) || recipe.ingredients.length === 0) {
      return res.status(400).json({ success: false, message: 'recipe.ingredients must be a non-empty array' });
    }

    const { planItem } = await loadOwnedPlanItem(dietPlan, planItemId);
    const newVersion = await createVersionFromSnapshot(planItem.recipeVersionId, recipe, { createdBy: req.user._id });

    planItem.recipeVersionId = newVersion._id;
    planItem.calculatedNutrition = newVersion.nutritionPerServing;
    await planItem.save();

    if (dietPlan.workflowStatus === 'menu_generated') {
      dietPlan.workflowStatus = 'portions_refined';
      await dietPlan.save();
    }

    return res.status(200).json({ success: true, data: { planItem, recipeVersion: newVersion } });
  } catch (error) {
    if (error.message === 'PlanItem not found' || error.message?.startsWith('RecipeVersion not found')) {
      return res.status(404).json({ success: false, message: error.message });
    }
    if (error.message?.includes('ingredients') && error.message?.includes('matched')) {
      return res.status(400).json({ success: false, message: error.message });
    }
    next(error);
  }
};

/**
 * @desc    Step 3: Auto-Balance one item / one day / one week's unlocked
 *          items to hit a calorie target, by uniformly scaling ingredient
 *          quantities.
 * @route   POST /api/dietician/patients/:patientId/diet-plans/:dietPlanId/auto-balance
 * @access  Private (Dietician)
 */
exports.autoBalance = async (req, res, next) => {
  try {
    const dietPlan = await loadPlanItemDietPlan(req, res);
    if (!dietPlan) return;

    const { scope, planItemId, dayPlanId, week, targetCalories, targetDailyCalories } = req.body || {};

    if (scope === 'item') {
      if (!mongoose.Types.ObjectId.isValid(planItemId) || !(targetCalories > 0)) {
        return res.status(400).json({ success: false, message: 'planItemId and a positive targetCalories are required for scope:item' });
      }
      const { planItem } = await loadOwnedPlanItem(dietPlan, planItemId);
      if (planItem.locked) {
        return res.status(200).json({ success: true, data: { skipped: true, reason: 'locked' } });
      }
      const newVersion = await autoBalanceIngredients(planItem.recipeVersionId, targetCalories);
      planItem.recipeVersionId = newVersion._id;
      planItem.calculatedNutrition = newVersion.nutritionPerServing;
      await planItem.save();
      return res.status(200).json({ success: true, data: { planItem, recipeVersion: newVersion } });
    }

    if (scope === 'day') {
      if (!mongoose.Types.ObjectId.isValid(dayPlanId) || !(targetDailyCalories > 0)) {
        return res.status(400).json({ success: false, message: 'dayPlanId and a positive targetDailyCalories are required for scope:day' });
      }
      const targetDayPlan = await DayPlan.findById(dayPlanId);
      if (!targetDayPlan || String(targetDayPlan.dietPlanId) !== String(dietPlan._id)) {
        return res.status(404).json({ success: false, message: 'DayPlan not found' });
      }
      const results = await autoBalanceDay(dayPlanId, targetDailyCalories);
      return res.status(200).json({ success: true, data: { results } });
    }

    if (scope === 'week') {
      if (!Number.isInteger(week) || week < 1 || week > 4 || !(targetDailyCalories > 0)) {
        return res.status(400).json({ success: false, message: 'week (1-4) and a positive targetDailyCalories are required for scope:week' });
      }
      const results = await autoBalanceWeek(dietPlan._id, week, targetDailyCalories);
      return res.status(200).json({ success: true, data: { results } });
    }

    return res.status(400).json({ success: false, message: "scope must be 'item', 'day', or 'week'" });
  } catch (error) {
    if (error.message === 'PlanItem not found') {
      return res.status(404).json({ success: false, message: error.message });
    }
    next(error);
  }
};

/**
 * @desc    Step 5 read model: every DayPlan/MealSlotPlan/PlanItem for one
 *          week, with RecipeVersion details joined in for display.
 * @route   GET /api/dietician/patients/:patientId/diet-plans/:dietPlanId/weeks/:week/plan-items
 * @access  Private (Dietician)
 */
exports.getWeekPlanItems = async (req, res, next) => {
  try {
    const dietPlan = await loadPlanItemDietPlan(req, res);
    if (!dietPlan) return;

    const week = Number(req.params.week);
    if (!Number.isInteger(week) || week < 1 || week > 4) {
      return res.status(400).json({ success: false, message: 'week must be an integer between 1 and 4' });
    }

    const dayPlans = await DayPlan.find({ dietPlanId: dietPlan._id, week });
    const dayPlanById = new Map(dayPlans.map((dp) => [String(dp._id), dp]));
    const mealSlots = await MealSlotPlan.find({ dayPlanId: { $in: dayPlans.map((dp) => dp._id) } });
    const mealSlotById = new Map(mealSlots.map((ms) => [String(ms._id), ms]));
    const planItems = await PlanItem.find({ mealSlotId: { $in: mealSlots.map((ms) => ms._id) } });
    const supplementItems = await SupplementItem.find({ mealSlotId: { $in: mealSlots.map((ms) => ms._id) } });

    const recipeVersionIds = planItems.map((item) => item.recipeVersionId);
    const recipeVersions = await RecipeVersion.find({ _id: { $in: recipeVersionIds } });

    // Join each ingredient's foodItemName/nutritionPer100g in -
    // RecipeVersion.ingredients[] only stores foodItemId, and the Ingredient
    // Editor UI needs a real name to show/edit plus per-100g nutrition for
    // its client-side live "Current: X Cal" recompute (the authoritative
    // recompute still happens server-side in createCustomVersion at Save
    // time - this is display-only, matching services/recipeVersioningService.js's
    // own computeNutritionFromIngredients math so the two never diverge).
    //
    // resolvedGramsPerUnit is the grams-equivalent of exactly ONE unit of
    // this ingredient's OWN unit (e.g. 40 for a 'piece' of Chapati, 1.2 for
    // a 'nos' Almond), computed the same way createCustomVersion resolves
    // nutrition (services/recipeVersioningService.js's resolveGramsForIngredient) -
    // still never the raw unitConversions/density map itself. Without this,
    // the client could only ever show a live calorie figure for a 'g'-unit
    // ingredient (see ingredient_editor_sheet.dart's own doc comment on
    // that former limitation) - every other unit showed "-" regardless of
    // how complete the FoodItem's own nutrition data actually was. Null
    // when unresolvable (no FoodItem, or no known conversion for this
    // unit) - the client already treats null as "-", never a guessed number.
    //
    // gramsPerUnitByUnit is the SAME figure precomputed for every unit this
    // ingredient COULD be switched to (not just its current one) - lets the
    // Ingredient Editor recompute a live calorie figure the instant a
    // dietician changes an ingredient's unit, instead of the previous
    // "switching a unit invalidates the calorie figure to '-' until the
    // version is re-fetched after Save" behavior (reported as "Lemon" only
    // when switched to 'tsp' - the client had no way to resolve a unit it
    // hadn't been told about). Only ever includes units that actually
    // resolve for this FoodItem (never a guessed number, same as
    // resolvedGramsPerUnit) - a unit missing from the map means "still
    // unresolvable for this ingredient", exactly like resolvedGramsPerUnit
    // being null does today.
    const foodItemIds = recipeVersions.flatMap((v) => v.ingredients.map((ing) => ing.foodItemId));
    const foodItems = await FoodItem.find({ _id: { $in: foodItemIds } }).select('name nutritionPer100g unitConversions density');
    const foodItemById = new Map(foodItems.map((f) => [String(f._id), f]));
    const gramsPerUnitMapFor = (foodItem) => {
      const map = {};
      for (const unit of COMPONENT_UNITS) {
        const grams = resolveGramsForIngredient(foodItem, 1, unit);
        if (grams !== null) map[unit] = grams;
      }
      return map;
    };

    const recipeVersionById = new Map(
      recipeVersions.map((v) => {
        const plain = v.toObject();
        plain.ingredients = plain.ingredients.map((ing) => {
          const foodItem = foodItemById.get(String(ing.foodItemId));
          return {
            ...ing,
            foodItemName: foodItem?.name || null,
            nutritionPer100g: foodItem?.nutritionPer100g || null,
            resolvedGramsPerUnit: foodItem ? resolveGramsForIngredient(foodItem, 1, ing.unit) : null,
            gramsPerUnitByUnit: foodItem ? gramsPerUnitMapFor(foodItem) : {},
          };
        });
        return [String(v._id), plain];
      })
    );

    const supplementRecipeIds = supplementItems.map((s) => s.supplementRecipeId);
    const supplementRecipes = await Recipe.find({ _id: { $in: supplementRecipeIds } }).select('name');
    const supplementRecipeById = new Map(supplementRecipes.map((r) => [String(r._id), r]));

    const days = DAY_GROUPS.map((dayGroup) => {
      const dayPlan = dayPlans.find((dp) => dp.dayGroup === dayGroup);
      if (!dayPlan) return { dayGroup, meals: [] };

      const meals = REQUIRED_SERVING_TIMES.map((servingTime) => {
        const mealSlot = mealSlots.find((ms) => String(ms.dayPlanId) === String(dayPlan._id) && ms.servingTime === servingTime);
        if (!mealSlot) return { servingTime, items: [], supplements: [] };

        const items = planItems
          .filter((item) => String(item.mealSlotId) === String(mealSlot._id))
          .map((item) => ({
            _id: item._id,
            recipeVersionId: item.recipeVersionId,
            recipeVersion: recipeVersionById.get(String(item.recipeVersionId)) || null,
            locked: item.locked,
            calculatedNutrition: item.calculatedNutrition,
            isLinkedComponent: item.isLinkedComponent,
            parentRecipeId: item.parentRecipeId,
          }));

        const supplements = supplementItems
          .filter((s) => String(s.mealSlotId) === String(mealSlot._id))
          .map((s) => ({
            _id: s._id,
            supplementRecipeId: s.supplementRecipeId,
            supplementName: supplementRecipeById.get(String(s.supplementRecipeId))?.name || null,
            dosage: s.dosage,
            instructions: s.instructions,
            timingAnchor: s.timingAnchor,
            locked: s.locked,
            excludeFromCalories: s.excludeFromCalories,
          }));

        return { servingTime, mealSlotId: mealSlot._id, items, supplements };
      });

      return { dayGroup, dayPlanId: dayPlan._id, meals };
    });

    return res.status(200).json({ success: true, data: { week, workflowStatus: dietPlan.workflowStatus, days } });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Step 2's swap icon: repoint a PlanItem at a different recipe's
 *          V1 RecipeVersion - no rescale, see
 *          services/recipeVersionSwapService.js's header.
 * @route   POST /api/dietician/patients/:patientId/diet-plans/:dietPlanId/swap-recipe-version
 * @access  Private (Dietician)
 */
exports.swapRecipeVersion = async (req, res, next) => {
  try {
    const dietPlan = await loadPlanItemDietPlan(req, res);
    if (!dietPlan) return;

    const { planItemId, newParentRecipeId } = req.body || {};
    if (!mongoose.Types.ObjectId.isValid(planItemId) || !mongoose.Types.ObjectId.isValid(newParentRecipeId)) {
      return res.status(400).json({ success: false, message: 'planItemId and newParentRecipeId must be valid ids' });
    }

    await loadOwnedPlanItem(dietPlan, planItemId); // ownership check, result unused - swapToRecipe re-fetches
    const item = await swapToRecipe(planItemId, newParentRecipeId);

    return res.status(200).json({ success: true, data: { item } });
  } catch (error) {
    if (error.message === 'PlanItem not found' || error.message?.startsWith('No Active V1') || error.message?.includes('unresolved ingredients')) {
      return res.status(404).json({ success: false, message: error.message });
    }
    next(error);
  }
};

/**
 * @desc    Step 2: add an extra recipe to a meal slot (a slot can hold more
 *          than one item - e.g. a dietician wants two independent dishes at
 *          Lunch, not just the auto-generated main+linked-side). Points at
 *          the chosen recipe's Active, fully-resolved V1 - same eligibility
 *          gate as menuGenerationService.js's candidate pool.
 * @route   POST /api/dietician/patients/:patientId/diet-plans/:dietPlanId/plan-items
 * @access  Private (Dietician)
 */
exports.addPlanItem = async (req, res, next) => {
  try {
    const dietPlan = await loadPlanItemDietPlan(req, res);
    if (!dietPlan) return;

    const { mealSlotId, recipeId } = req.body || {};
    if (!mongoose.Types.ObjectId.isValid(mealSlotId) || !mongoose.Types.ObjectId.isValid(recipeId)) {
      return res.status(400).json({ success: false, message: 'mealSlotId and recipeId must be valid ids' });
    }

    await loadOwnedMealSlot(dietPlan, mealSlotId);

    const v1 = await RecipeVersion.findOne({ parentRecipeId: recipeId, versionNumber: 1, status: 'Active' });
    if (!v1) {
      return res.status(404).json({ success: false, message: 'No Active V1 RecipeVersion found for this recipe' });
    }
    if (v1.hasUnresolvedIngredients) {
      return res.status(404).json({ success: false, message: 'This recipe has unresolved ingredients and cannot be added yet' });
    }

    const planItem = await PlanItem.create({
      mealSlotId,
      recipeVersionId: v1._id,
      calculatedNutrition: v1.nutritionPerServing,
    });

    return res.status(201).json({ success: true, data: { planItem } });
  } catch (error) {
    if (error.message === 'MealSlot not found') {
      return res.status(404).json({ success: false, message: error.message });
    }
    next(error);
  }
};

/**
 * @desc    Step 2: remove one item from a meal slot entirely, no
 *          replacement (distinct from swap, which replaces the recipe -
 *          this leaves the slot with one fewer item, or empty).
 * @route   DELETE /api/dietician/patients/:patientId/diet-plans/:dietPlanId/plan-items/:planItemId
 * @access  Private (Dietician)
 */
exports.removePlanItem = async (req, res, next) => {
  try {
    const dietPlan = await loadPlanItemDietPlan(req, res);
    if (!dietPlan) return;

    const { planItemId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(planItemId)) {
      return res.status(400).json({ success: false, message: 'planItemId must be a valid id' });
    }

    const { planItem } = await loadOwnedPlanItem(dietPlan, planItemId);
    if (planItem.locked) {
      return res.status(409).json({ success: false, message: 'This item is locked and cannot be removed' });
    }
    await PlanItem.deleteOne({ _id: planItemId });

    return res.status(200).json({ success: true, data: { removed: true } });
  } catch (error) {
    if (error.message === 'PlanItem not found') {
      return res.status(404).json({ success: false, message: error.message });
    }
    next(error);
  }
};

/**
 * @desc    Step 4: add/update a supplement in one meal slot's timeline.
 *          Upserts on {mealSlotId, supplementRecipeId} - resubmitting the
 *          same supplement updates its dosage/instructions/timing rather
 *          than duplicating it.
 * @route   POST /api/dietician/patients/:patientId/diet-plans/:dietPlanId/timeline-supplements
 * @access  Private (Dietician)
 */
exports.upsertSupplementItem = async (req, res, next) => {
  try {
    const dietPlan = await loadPlanItemDietPlan(req, res);
    if (!dietPlan) return;

    const week = Number(req.body?.week);
    const { dayGroup, servingTime, supplementRecipeId, dosage, instructions, timingAnchor } = req.body || {};

    if (!Number.isInteger(week) || week < 1 || week > 4) {
      return res.status(400).json({ success: false, message: 'week must be an integer between 1 and 4' });
    }
    if (!DAY_GROUPS.includes(dayGroup) || !REQUIRED_SERVING_TIMES.includes(servingTime)) {
      return res.status(400).json({ success: false, message: 'dayGroup/servingTime is not a recognized slot' });
    }
    if (!mongoose.Types.ObjectId.isValid(supplementRecipeId)) {
      return res.status(400).json({ success: false, message: 'supplementRecipeId must be a valid recipe id' });
    }
    if (!['pre', 'with', 'post'].includes(timingAnchor)) {
      return res.status(400).json({ success: false, message: "timingAnchor must be 'pre', 'with', or 'post'" });
    }

    const dayPlan = await DayPlan.findOneAndUpdate(
      { dietPlanId: dietPlan._id, week, dayGroup },
      { $setOnInsert: { dietPlanId: dietPlan._id, patientId: dietPlan.patientId, week, dayGroup } },
      { upsert: true, returnDocument: 'after' }
    );
    const mealSlot = await MealSlotPlan.findOneAndUpdate(
      { dayPlanId: dayPlan._id, servingTime },
      { $setOnInsert: { dayPlanId: dayPlan._id, servingTime } },
      { upsert: true, returnDocument: 'after' }
    );

    const supplementItem = await SupplementItem.findOneAndUpdate(
      { mealSlotId: mealSlot._id, supplementRecipeId },
      { $set: { dosage: dosage ?? null, instructions: instructions ?? null, timingAnchor } },
      { upsert: true, returnDocument: 'after', runValidators: true }
    );

    if (dietPlan.workflowStatus === 'portions_refined') {
      dietPlan.workflowStatus = 'timeline_defined';
      await dietPlan.save();
    }

    return res.status(200).json({ success: true, data: { supplementItem } });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Step 5: activate this plan - the real spec.md gate, blocking
 *          unless every generated day is within +/-5% of the plan's
 *          calorie target (services/planActivationService.js). Only
 *          flips workflowStatus once that holds; the dietician having
 *          reviewed the detailed view is not itself sufficient.
 * @route   POST /api/dietician/patients/:patientId/diet-plans/:dietPlanId/finalize-plan-item-week
 * @access  Private (Dietician)
 */
exports.finalizePlanItemWeek = async (req, res, next) => {
  try {
    const dietPlan = await loadPlanItemDietPlan(req, res);
    if (!dietPlan) return;

    const targetCalories = dietPlan.calorieStrategy?.calorieBudget;
    if (!(targetCalories > 0)) {
      return res.status(400).json({ success: false, message: 'This plan has no calorie target set (Step 1) - cannot validate activation.' });
    }

    const validation = await validatePlanForActivation(dietPlan._id, targetCalories);
    if (!validation.withinTolerance) {
      const offDays = validation.days.filter((day) => !day.withinTolerance);
      return res.status(422).json({
        success: false,
        message: `${offDays.length} day(s) are outside the +/-5% calorie tolerance and must be adjusted before activating.`,
        data: { days: validation.days },
      });
    }

    // Mirrors legacy finalizeWeekPlan's own "Draft -> Finalized" promotion
    // (dietPlanController.js) - dietPlanController.js::activateDietPlan
    // requires dietPlan.status === 'Finalized' before it will flip a plan to
    // 'Active'. workflowStatus alone (below) is wizard-progress bookkeeping,
    // not this model-wide status field - without this, the dietician app's
    // "Confirm & Activate" (finalize-plan-item-week, then .../activate)
    // would 400 on the activate call every time for a plan-item plan.
    if (dietPlan.status === 'Draft') {
      dietPlan.status = 'Finalized';
    }

    dietPlan.workflowStatus = 'finalized';
    await dietPlan.save();

    return res.status(200).json({ success: true, data: { workflowStatus: dietPlan.workflowStatus, days: validation.days } });
  } catch (error) {
    next(error);
  }
};
