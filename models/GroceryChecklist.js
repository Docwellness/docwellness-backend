const mongoose = require('mongoose');

/**
 * Which grocery-list items a patient has ticked as "bought", per week.
 *
 * The grocery list itself is NOT stored - it's derived on every request from
 * the diet plan (see dietController.getGroceriesForCurrentWeek /
 * buildGroceryItemsForWeek). This only persists the patient's ticks, keyed by
 * each item's stable `key` from that builder (the canonical normalized
 * ingredient name, or `supplement:<name>` for a supplement line item), so a
 * tick survives app restarts and plan reloads and simply stops matching if
 * the dietician removes that ingredient from the week.
 *
 * `week` is the DISPLAY week number ((cycleNumber-1)*4 + n) the groceries
 * endpoint returns, which is unique per patient across renewal cycles.
 */
const groceryChecklistSchema = new mongoose.Schema(
  {
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
    checkedKeys: {
      type: [String],
      default: [],
    },
  },
  { timestamps: true }
);

// One checklist per patient per display-week
groceryChecklistSchema.index({ patientId: 1, week: 1 }, { unique: true });

module.exports = mongoose.model('GroceryChecklist', groceryChecklistSchema);
