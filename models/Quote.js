const mongoose = require('mongoose');

const quoteSchema = new mongoose.Schema(
  {
    dieticianId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    // Optional now - quotes are text-first (see scripts/seed-quotes.js and
    // the user app's "Daily wisdom" carousel). An image is still allowed.
    imageUrl: {
      type: String,
      default: '',
    },
    cloudinaryPublicId: {
      type: String,
      default: '',
    },
    // Same quote in three languages, all shown on one card in the app.
    // `text` is English (kept as the canonical field used by notifications).
    text: {
      type: String,
      default: '',
      trim: true,
    },
    textHi: {
      type: String,
      default: '',
      trim: true,
    },
    textMr: {
      type: String,
      default: '',
      trim: true,
    },
    author: {
      type: String,
      default: 'DocWellness',
      trim: true,
    },
    category: {
      type: String,
      enum: ['Nutrition', 'Wellness', 'Mindfulness'],
      default: 'Wellness',
    },
    isActive: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Quote', quoteSchema);
