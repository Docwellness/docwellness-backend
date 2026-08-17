const mongoose = require('mongoose');

const mealLogSchema = new mongoose.Schema(
  {
    patientId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    date: {
      type: Date,
      required: true,
      default: Date.now,
    },
    // Canonical "which calendar day is this" identifier, UTC 'YYYY-MM-DD'
    // (see dietController.js's dateToDayKey/normalizeDate) - `date` alone is
    // exact-value-equal for any two writes that went through normalizeDate,
    // but dayKey makes the day identity explicit and queryable, and backs
    // the uniqueness guarantee below so a patient can never end up with two
    // MealLog documents silently splitting one day's data.
    dayKey: {
      type: String,
      index: true,
    },
    meals: [
      {
        mealType: {
          type: String,
          enum: [
            'Morning Drink',
            'Breakfast',
            'Brunch',
            'Lunch',
            'Evening Snack',
            'Dinner',
            'Night Drink',
          ],
          required: true,
        },
        servingTime: {
          type: String,
          enum: [
            'Morning Drink',
            'Breakfast',
            'Brunch',
            'Lunch',
            'Evening Snack',
            'Dinner',
            'Night Drink',
          ],
          required: true,
        },
        recipeId: {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'Recipe',
        },
        servings: {
          type: Number,
          default: 1,
        },
        caloriesConsumed: {
          type: Number,
        },
        notes: {
          type: String,
          trim: true,
        },
      },
    ],
    dietaryHabits: {
      vegan: { type: Boolean, default: false },
      jain: { type: Boolean, default: false },
      vegetarian: { type: Boolean, default: false },
      nonVegetarian: { type: Boolean, default: false },
      eggitarian: { type: Boolean, default: false },
    },
    freeFrom: {
      sugar: { type: Boolean, default: false },
      salt: { type: Boolean, default: false },
      processedFood: { type: Boolean, default: false },
      oil: { type: Boolean, default: false },
    },
    totalCalories: {
      type: Number,
      default: 0,
    },
  },
  {
    timestamps: true,
  }
);

// Index for efficient querying by patient and date
mealLogSchema.index({ patientId: 1, date: 1 });

// One meal log per patient per calendar day - the real guard against a
// past/current day's log ever getting silently duplicated or merged into
// the wrong day. `sparse` here only skips a document missing EVERY indexed
// field; patientId is always set, so a pre-dayKey document is *not*
// excluded and would collide with any sibling also missing dayKey (both
// index as `dayKey: null`) - run scripts/maintenance/backfill-meal-log-day-
// keys.js before scripts/maintenance/ensure-indexes.js in any environment
// with data older than this field, or index creation fails on the
// resulting duplicate-key error.
mealLogSchema.index({ patientId: 1, dayKey: 1 }, { unique: true, sparse: true });

module.exports = mongoose.model('MealLog', mealLogSchema);
