const mongoose = require('mongoose');

const quoteSchema = new mongoose.Schema(
  {
    dieticianId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    imageUrl: {
      type: String,
      required: true,
    },
    cloudinaryPublicId: {
      type: String,
      default: '',
    },
    text: {
      type: String,
      default: '',
      trim: true,
    },
    isActive: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Quote', quoteSchema);
