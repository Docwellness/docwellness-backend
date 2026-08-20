/**
 * When a recipe's nutrition is edited in the Recipe module, find every plan
 * that references it in days[] and recompute those items' calculatedNutrition
 * - the "Smart Sync" toast (dietician UI) surfaces the returned change-list
 * so the dietician can see what just moved.
 *
 * Scope note: days[] (models/DietPlan.js, Phase 1c/1d) currently only ever
 * holds already-*finalized* selections - finalizeWeekPlan is the only writer
 * that dual-writes into it (see that function's comment: a draft save must
 * never populate days[] with unreviewed data). So "don't silently touch an
 * already-patient-visible past week" can't be decided by finalized-vs-draft
 * here (everything in days[] is finalized) - it's decided by whether the
 * week has actually started yet, via dietPlan.weekSchedule. A week whose
 * startDate is still in the future is finalized-but-not-yet-lived, so
 * resyncing it is safe; a week that already started may have real logged
 * meals tied to what was actually served, and is left untouched.
 */

function isWeekUpcoming(dietPlan, week, now = new Date()) {
  const schedule = (dietPlan.weekSchedule || []).find((w) => w.week === week);
  if (!schedule?.startDate) return false; // no schedule info - conservatively treat as not-safe-to-touch
  return new Date(schedule.startDate).getTime() > now.getTime();
}

/**
 * @param plans  DietPlan documents already queried by the caller (typically
 *   `DietPlan.find({'days.meals.items.recipeId': recipeId, status: {$in:
 *   ['Active','Finalized']}})`) - this function does no DB access itself.
 * @returns { plansTouched: [{ dietPlanId, changedItems: [{week, dayGroup,
 *   servingTime, itemId}] }] } - callers still need to .save() each touched
 *   plan.
 */
function syncRecipeChange({ plans, recipeId, updatedNutritionPerServing, now = new Date() }) {
  const { scaleNutrition } = require('./nutritionCalculatorService');
  const targetId = recipeId?.toString ? recipeId.toString() : recipeId;
  const plansTouched = [];

  for (const plan of plans || []) {
    const changedItems = [];

    for (const day of plan.days || []) {
      if (!isWeekUpcoming(plan, day.week, now)) continue;

      for (const meal of day.meals || []) {
        for (const item of meal.items || []) {
          const itemRecipeId = item.recipeId?.toString ? item.recipeId.toString() : item.recipeId;
          if (itemRecipeId !== targetId) continue;

          item.calculatedNutrition = updatedNutritionPerServing
            ? scaleNutrition(updatedNutritionPerServing, item.servingMultiplier ?? 1)
            : item.calculatedNutrition;

          changedItems.push({
            week: day.week,
            dayGroup: day.dayGroup,
            servingTime: meal.servingTime,
            itemId: item._id?.toString() || null,
          });
        }
      }
    }

    if (changedItems.length > 0) {
      plan.markModified('days');
      plansTouched.push({ dietPlanId: plan._id?.toString() || null, changedItems });
    }
  }

  return { plansTouched };
}

module.exports = { syncRecipeChange, isWeekUpcoming };
