const mongoose = require('mongoose');

const dietPlanSchema = new mongoose.Schema(
  {
    patientId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    dieticianId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    name: {
      type: String,
      default: 'Diet Plan',
      trim: true,
    },
    description: {
      type: String,
      trim: true,
    },
    startDate: {
      type: Date,
    },
    endDate: {
      type: Date,
    },
    mealsPerDay: {
      type: Number,
      default: 3,
    },
    totalCalories: {
      type: Number,
    },
    status: {
      type: String,
      enum: ['Draft', 'Active', 'Completed', 'Finalized'],
      default: 'Draft',
    },
    activationDate: {
      type: Date,
      default: null,
    },
    isPaid: {
      type: Boolean,
      default: false,
    },
    price: {
      type: Number,
      default: 0,
    },
    paymentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Payment',
    },
    request: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'DietPlanRequest',
    },
    firstConsultation: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'FirstConsultation',
    },
    calorieStrategy: {
      name: { type: String },
      calorieBudget: { type: Number },
      calorieDeficit: { type: Number },
      weeklyWeightLossKg: { type: Number },
      durationWeeks: { type: Number },
    },
    macroStrategy: {
      name: { type: String },
      fatPercent: { type: Number },
      carbsPercent: { type: Number },
      proteinPercent: { type: Number },
    },
    generatedPlan: {
      type: String,
    },
    generatedAt: {
      type: Date,
    },
    finalizedPlan: {
      type: Object,
      default: null,
    },
    weeksSummary: [
      {
        week: { type: Number, required: true },
        totalCalories: { type: Number, default: 0 },
        fatPercent: { type: Number, default: 0 },
        fatGrams: { type: Number, default: 0 },
        carbPercent: { type: Number, default: 0 },
        carbGrams: { type: Number, default: 0 },
        proteinPercent: { type: Number, default: 0 },
        proteinGrams: { type: Number, default: 0 },
        fiberGrams: { type: Number, default: 0 },
      },
    ],
    meals: [
      {
        mealType: {
          type: String,
          enum: ['Breakfast', 'Lunch', 'Dinner', 'Snack'],
          required: true,
        },
        recipes: [
          {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Recipe',
          },
        ],
        totalCalories: { type: Number },
        macros: {
          protein: { type: Number },
          carbs: { type: Number },
          fats: { type: Number },
        },
      },
    ],
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model('DietPlan', dietPlanSchema);
