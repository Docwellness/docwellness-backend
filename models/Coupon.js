const mongoose = require('mongoose');

const couponSchema = new mongoose.Schema(
  {
    dieticianId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    code: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
    },
    discountPercentage: {
      type: Number,
      required: true,
      min: [1, 'Discount must be at least 1%'],
      max: [100, 'Discount cannot exceed 100%'],
    },
    validTill: {
      type: Date,
      required: true,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true }
);

// Unique coupon code per dietician
couponSchema.index({ dieticianId: 1, code: 1 }, { unique: true });

module.exports = mongoose.model('Coupon', couponSchema);
