/**
 * v4.0's Step 5 activation gate (spec.md's "Step 5 - Finalize and Activate":
 * only allow activation when every day's total calories are within +/-5% of
 * that day's calorie target). Computes each generated DayPlan's actual
 * calorie total from PlanItem.calculatedNutrition only - SupplementItems are
 * a separate collection and never contribute here, matching
 * SupplementItem.excludeFromCalories/design.md's "supplements excluded from
 * calorie totals" decision, so no explicit filtering for them is needed.
 */

const DayPlan = require('../models/DayPlan');
const MealSlotPlan = require('../models/MealSlotPlan');
const PlanItem = require('../models/PlanItem');

const ACTIVATION_CALORIE_TOLERANCE = 0.05;

async function computeDayCalorieTotal(dayPlanId) {
  const mealSlots = await MealSlotPlan.find({ dayPlanId });
  const planItems = await PlanItem.find({ mealSlotId: { $in: mealSlots.map((slot) => slot._id) } });
  return planItems.reduce((sum, item) => sum + (item.calculatedNutrition?.calories || 0), 0);
}

/**
 * Returns { targetCalories, withinTolerance, days } for every DayPlan
 * currently generated under dietPlanId (across all weeks) - a day with no
 * PlanItems yet (never generated) is excluded, since there's nothing to
 * validate for a slot that hasn't been filled in.
 */
async function validatePlanForActivation(dietPlanId, targetCalories) {
  const dayPlans = await DayPlan.find({ dietPlanId });
  const days = [];

  for (const dayPlan of dayPlans) {
    const totalCalories = await computeDayCalorieTotal(dayPlan._id);
    if (totalCalories <= 0) continue;

    const deviation = Math.abs(totalCalories - targetCalories) / targetCalories;
    days.push({
      dayPlanId: dayPlan._id,
      week: dayPlan.week,
      dayGroup: dayPlan.dayGroup,
      totalCalories: Math.round(totalCalories * 100) / 100,
      deviationPercent: Math.round(deviation * 10000) / 100,
      withinTolerance: deviation <= ACTIVATION_CALORIE_TOLERANCE,
    });
  }

  return {
    targetCalories,
    withinTolerance: days.every((day) => day.withinTolerance),
    days,
  };
}

module.exports = { ACTIVATION_CALORIE_TOLERANCE, computeDayCalorieTotal, validatePlanForActivation };
