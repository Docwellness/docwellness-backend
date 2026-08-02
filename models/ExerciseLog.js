const mongoose = require('mongoose');

// What a patient actually logged for a given day - mirrors MealLog.js's
// shape closely (patientId+date scoped, one array of logged entries, a
// cached total). caloriesBurned on each entry is always computed
// server-side at log time (met * weightKg * durationHours - see
// utils/exerciseHelpers.js), never trusted from the client, unlike
// MealLog's caloriesConsumed (which is a scaled recipe-nutrition figure the
// server already trusts) - MET-based burn is a formula the server owns
// outright.
const exerciseLogSchema = new mongoose.Schema(
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
    exercises: [
      {
        exerciseId: {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'Exercise',
          required: true,
        },
        durationMinutes: {
          type: Number,
          required: true,
        },
        sets: {
          type: Number,
          default: null,
        },
        reps: {
          type: Number,
          default: null,
        },
        caloriesBurned: {
          type: Number,
          default: 0,
        },
        completedAt: {
          type: Date,
          default: Date.now,
        },
        notes: {
          type: String,
          trim: true,
        },
      },
    ],
    totalCaloriesBurned: {
      type: Number,
      default: 0,
    },
  },
  {
    timestamps: true,
  }
);

exerciseLogSchema.index({ patientId: 1, date: 1 });

module.exports = mongoose.model('ExerciseLog', exerciseLogSchema);
