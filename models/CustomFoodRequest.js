const mongoose = require('mongoose');

const customFoodRequestSchema = new mongoose.Schema(
  {
    patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    dieticianId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    date: { type: Date, required: true },
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
    imageUrl: { type: String },
    foodName: { type: String, required: true },
    description: { type: String },
    quantityLabel: { type: String },
    portion: { type: Number, default: 1 },
    status: {
      type: String,
      enum: ['Pending', 'Accepted', 'Rejected'],
      default: 'Pending',
    },
    dieticianNote: { type: String },
  },
  {
    timestamps: true,
  }
);

customFoodRequestSchema.index({ dieticianId: 1, status: 1, createdAt: -1 });

module.exports = mongoose.model('CustomFoodRequest', customFoodRequestSchema);