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

module.exports = mongoose.model('MealLog', mealLogSchema);
