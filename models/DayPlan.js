const mongoose = require('mongoose');
const { DAY_GROUPS } = require('../utils/dayGroups');

// v4.0's per-{week,dayGroup} anchor for a 'plan-item' DietPlan - the
// standalone-collection equivalent of one entry in the old
// DietPlan.days[] embedded array. Deliberately keyed the same {week,
// dayGroup} way (utils/dayGroups.js's 4-entry DAY_GROUPS: Monday/Tuesday/
// Wednesday/Thursday, each repeating across the real calendar week), NOT 7
// real calendar days - reusing this model avoids re-deriving the
// "Monday's meals also apply Friday" domain rule that generation/scheduling
// already depends on.
//
// Only ever created for a DietPlan whose dataModel === 'plan-item' (see
// DietPlan.js's dataModel field) - a days-array plan never gets a DayPlan
// document, and this model is never read for one.
const dayPlanSchema = new mongoose.Schema(
  {
    dietPlanId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'DietPlan',
      required: true,
    },
    // Denormalized from dietPlanId so patient-side reads
    // (utils/dietPlanReadDispatch.js) can query directly without an extra
    // join through DietPlan first.
    patientId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    week: {
      type: Number,
      required: true,
      min: 1,
    },
    dayGroup: {
      type: String,
      enum: DAY_GROUPS,
      required: true,
    },
  },
  {
    timestamps: true,
  }
);

// The core lookup: "give me week 2's Wednesday group for this plan".
dayPlanSchema.index({ dietPlanId: 1, week: 1, dayGroup: 1 }, { unique: true });
dayPlanSchema.index({ patientId: 1 });

module.exports = mongoose.model('DayPlan', dayPlanSchema);
