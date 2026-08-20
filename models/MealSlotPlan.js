const mongoose = require('mongoose');
const { REQUIRED_SERVING_TIMES } = require('../utils/servingTimes');

// v4.0's per-servingTime slot within a DayPlan - the standalone-collection
// equivalent of one entry in the old DietPlan.days[].meals[] embedded array.
// Holds no food data itself; PlanItem/SupplementItem (below) reference this
// document's _id as their slot.
const mealSlotPlanSchema = new mongoose.Schema(
  {
    dayPlanId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'DayPlan',
      required: true,
    },
    servingTime: {
      type: String,
      enum: REQUIRED_SERVING_TIMES,
      required: true,
    },
  },
  {
    timestamps: true,
  }
);

mealSlotPlanSchema.index({ dayPlanId: 1, servingTime: 1 }, { unique: true });

module.exports = mongoose.model('MealSlotPlan', mealSlotPlanSchema);
