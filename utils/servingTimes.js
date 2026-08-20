// Extracted from models/DietPlan.js (where it was previously a private local
// const) because models/MealSlotPlan.js (v4.0's ingredient-versioning data
// model) now needs the exact same enum - keeping it in one place avoids the
// two schemas' serving-time lists silently drifting apart.

const REQUIRED_SERVING_TIMES = [
  'Morning Drink',
  'Breakfast',
  'Brunch',
  'Lunch',
  'Evening Snack',
  'Dinner',
  'Night Drink',
];

module.exports = { REQUIRED_SERVING_TIMES };
